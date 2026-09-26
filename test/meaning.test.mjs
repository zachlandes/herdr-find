import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { JEV_ENDPOINT, jevEndpoint } from "../lib/meaning/jev.mjs";
import { createRedactor } from "../lib/meaning/redaction.mjs";
import { LEDGER_FILE, MEANING, recordRun, searchByMeaning, spentInLastDay } from "../lib/meaning/search.mjs";
import { startStandin } from "./support/jev-standin.mjs";

const key = Object.freeze(Object.defineProperty({ source: "test" }, "authorization", { value: "Bearer test-key-not-real", enumerable: false }));
const items = (texts) => texts.map((text, index) => ({ id: `m${index}`, text }));
const judgeBy = (words) => (search, text) => (words.some((word) => text.includes(word)) ? 0.9 : 0.1);

async function withStandin(options, run) {
  const standin = await startStandin(options);
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "herdr-find-meaning-"));
  try {
    return await run({ standin, stateDir });
  } finally {
    await standin.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

const search = (standin, stateDir, extra) => searchByMeaning({
  query: "how much can we spend",
  key,
  redactor: createRedactor(),
  stateDir,
  capUsd: 0.01,
  dailyCapUsd: 0.05,
  endpoint: standin.url,
  retry: { maxRetries: 2, baseDelayMs: 0 },
  ...extra
});

test("matches come back ranked, found by meaning even with no shared words", async () => {
  await withStandin({ judge: (s, text) => (text.includes("five dollars") ? 0.95 : text.includes("budget") ? 0.7 : 0.05) }, async ({ standin, stateDir }) => {
    const streamed = [];
    const result = await search(standin, stateDir, {
      items: items(["the budget meeting moved", "cap it at five dollars a day", "unrelated note"]),
      onFound: (found) => streamed.push(...found.map((entry) => entry.item.id))
    });
    assert.deepEqual(result.found.map((entry) => entry.id), ["m1", "m0"]);
    assert.deepEqual(streamed.sort(), ["m0", "m1"]);
    assert.equal(result.closest, false);
    assert.equal(result.run.read, 3);
  });
});

test("when nothing passes the floor, the three closest are shown and said to be closest", async () => {
  await withStandin({ judge: () => 0.2 }, async ({ standin, stateDir }) => {
    const result = await search(standin, stateDir, { items: items(["a", "b", "c", "d"].map((letter) => `note ${letter}`)) });
    assert.equal(result.closest, true);
    assert.equal(result.found.length, 3);
    assert.equal(result.run.matches, 0);
  });
});

test("text is redacted before it is sent, and ids in the body are request-local", async () => {
  await withStandin({ judge: judgeBy(["dollars"]) }, async ({ standin, stateDir }) => {
    const redactor = createRedactor({ rules: [["name", "Morgan", "[person]"]], forbidden: [] });
    await search(standin, stateDir, { redactor, items: [{ id: "w3-p1#7", text: "Morgan said five dollars; key sk-live-abcdefghijklmnopqrstuv" }] });
    const sent = standin.bodies.map((body) => body.raw).join("\n");
    assert.doesNotMatch(sent, /Morgan|sk-live-abcdef|w3-p1/);
    assert.match(sent, /\[person\] said five dollars/);
    assert.equal(standin.bodies[0].authorization, "Bearer test-key-not-real");
  });
});

test("a request in which a forbidden pattern survives is never sent", async () => {
  await withStandin({ judge: () => 0.9 }, async ({ standin, stateDir }) => {
    const redactor = createRedactor({ rules: [], forbidden: ["(?i)project falcon"] });
    const result = await search(standin, stateDir, { redactor, items: items(["the Project Falcon launch date"]) });
    assert.equal(standin.bodies.length, 0);
    assert.equal(result.run.refused_by_redaction, 1);
    assert.equal(result.found.length, 0);
  });
});

test("the search stops at its spend cap, reading newest first, so the oldest go unread", async () => {
  await withStandin({ judge: () => 0.1 }, async ({ standin, stateDir }) => {
    const long = (index) => ({ id: `m${index}`, text: `message ${index} `.repeat(1400) });
    const result = await search(standin, stateDir, { capUsd: 0.0005, experiment: { floor: 0.58, closest: 3, batch: 1, batchChars: 24000, inFlight: 1, maxItems: 5000, maxQueryChars: 400, maxSentences: 60, maxSentencePicks: 20, prompt: "find-meaning-v1", sentencePrompt: "find-sentence-v1", model: "jev-1.13.0" }, items: Array.from({ length: 12 }, (_, index) => long(index)) });
    assert.equal(result.run.stop, "search spend cap reached");
    assert.ok(result.run.read > 0 && result.run.read < 12);
    assert.ok(result.run.spend.committed_usd <= 0.0005);
    const read = standin.bodies.map((body) => Object.values(JSON.parse(body.raw).state.items)[0].slice(0, 11));
    assert.equal(read[0], "message 0 m");
  });
});

test("a day's spend is capped from the ledger, and a capped day sends nothing", async () => {
  await withStandin({ judge: () => 0.9 }, async ({ standin, stateDir }) => {
    recordRun(stateDir, { at: new Date().toISOString(), spend: { committed_usd: 0.05 } });
    const result = await search(standin, stateDir, { items: items(["anything"]) });
    assert.equal(result.run.stop, "daily spend cap reached");
    assert.equal(standin.bodies.length, 0);
  });
});

test("a busy service is retried, and the ledger records counts, never words or text", async () => {
  await withStandin({ judge: judgeBy(["dollars"]), failFirst: 1 }, async ({ standin, stateDir }) => {
    const result = await search(standin, stateDir, { items: items(["five dollars a day"]) });
    assert.equal(result.found.length, 1);
    assert.equal(standin.bodies.length, 2);
    recordRun(stateDir, result.run);
    const ledger = readFileSync(path.join(stateDir, LEDGER_FILE), "utf8");
    assert.doesNotMatch(ledger, /spend each|dollars|test-key/);
    assert.match(ledger, /"query_chars":21/);
  });
});

test("a search books what it spends as it goes, so one killed before it ends still counts toward the day", async () => {
  await withStandin({ judge: () => 0.1 }, async ({ standin, stateDir }) => {
    const result = await search(standin, stateDir, { experiment: { ...MEANING, batch: 1, inFlight: 1 }, items: items(["one", "two", "three"]) });
    assert.equal(standin.bodies.length, 3);
    // No end-of-run record, as when fzf kills the search
    assert.ok(spentInLastDay(stateDir) >= result.run.spend.committed_usd);
    recordRun(stateDir, result.run);
    assert.equal(spentInLastDay(stateDir), result.run.spend.committed_usd);
  });
});

test("a retried request is charged again, and the search cap still holds", async () => {
  await withStandin({ judge: () => 0.1, failFirst: 2, status: 503 }, async ({ standin, stateDir }) => {
    const long = (index) => ({ id: `m${index}`, text: `message ${index} `.repeat(1400) });
    const result = await search(standin, stateDir, { capUsd: 0.0005, experiment: { ...MEANING, batch: 1, inFlight: 1 }, items: Array.from({ length: 12 }, (_, index) => long(index)) });
    assert.equal(result.run.stop, "search spend cap reached");
    assert.ok(standin.bodies.length > result.run.read);
    assert.ok(result.run.spend.attempts_booked_at_reservation >= 2);
    assert.ok(result.run.spend.committed_usd <= 0.0005);
  });
});

test("the day's spend counts only recent runs, however long the ledger has grown", () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "herdr-find-ledger-"));
  try {
    const now = new Date();
    const old = new Date(now.getTime() - 3 * 24 * 3600 * 1000).toISOString();
    const lines = Array.from({ length: 2000 }, (_, index) => JSON.stringify({ run_id: `old-${index}`, at: old, spend: { committed_usd: 1 } }));
    const at = new Date(now.getTime() - 3600 * 1000).toISOString();
    lines.push(JSON.stringify({ run_id: "recent", at, spend: { committed_usd: 0.004 } }), JSON.stringify({ at, spend: { committed_usd: 0.002 } }));
    lines.push(...Array.from({ length: 400 }, () => JSON.stringify({ run_id: "recent", at, spend: { committed_usd: 0.004 } })));
    lines.push(JSON.stringify({ run_id: "recent", at, spend: { committed_usd: 0.005 } }));
    writeFileSync(path.join(stateDir, LEDGER_FILE), `${lines.join("\n")}\n`);
    assert.equal(Number(spentInLastDay(stateDir, now).toFixed(6)), 0.007);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("only a loopback address may stand in for the service", () => {
  assert.equal(jevEndpoint({ HERDR_FIND_JEV_ENDPOINT: "http://127.0.0.1:9/v1/systemone" }), "http://127.0.0.1:9/v1/systemone");
  assert.equal(jevEndpoint({ HERDR_FIND_JEV_ENDPOINT: "http://evil.example/v1" }), JEV_ENDPOINT);
  assert.equal(jevEndpoint({ HERDR_FIND_JEV_ENDPOINT: "https://localhost/v1" }), JEV_ENDPOINT);
  assert.equal(jevEndpoint({}), JEV_ENDPOINT);
});
