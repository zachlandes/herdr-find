import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import test from "node:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { act, EXACT_SHELL, exactTerms, fitWidth, fzfArgs, handleKey, headerFor, HEADER_WIDTH, startActions, summary } from "../lib/picker.mjs";
import { stripAnsi } from "../lib/gather.mjs";
import { recordRun } from "../lib/meaning/search.mjs";
import { createRun, loadState, removeRun } from "../lib/run.mjs";
import { BIN, makeWorld } from "./support/world.mjs";
import { startStandin } from "./support/jev-standin.mjs";

test("exact mode turns each word into fzf's exact term, in node and in the shell alike", () => {
  for (const query of ["spend cap", "  five   dollars ", "'already ^start !not | or", ""]) {
    const shell = execFileSync("sh", ["-c", EXACT_SHELL], { env: { ...process.env, FZF_QUERY: query }, encoding: "utf8" });
    assert.equal(shell, exactTerms(query), query);
  }
  assert.equal(exactTerms("spend cap"), "'spend 'cap");
});

test("an action argument is wrapped in brackets it does not contain", () => {
  assert.equal(act("change-query", "a (b)"), "change-query[a (b)]");
  assert.equal(act("change-query", "x)]}>~!"), "change-query(x]}>~!)");
  assert.equal(act("search", "one\ntwo"), "search(one two)");
});

test("every key the picker binds is one the help names", () => {
  const args = fzfArgs({ script: "/x/herdr-find", state: { mode: "fuzzy" }, header: "h", startActions: "ignore" });
  const keys = args.filter((_, index) => args[index - 1] === "--bind").map((bind) => bind.split(":")[0]);
  assert.deepEqual(keys, ["ctrl-s", "alt-f", "alt-e", "alt-m", "ctrl-o", "enter", "alt-enter", "ctrl-y", "focus", "change", "start", "every(0.25)"]);
});

async function picker(world, run) {
  const env = { ...world.env, HERDR_FIND_SCRIPT: "/x/herdr-find" };
  const dir = createRun({ contextPaneId: "w2:p1", scope: { type: "pane" }, mode: "fuzzy", env });
  const key = (name, fields = [], query = "") => handleKey(dir, name, fields, { ...env, FZF_QUERY: query });
  try {
    await run({ dir, key, state: () => loadState(dir) });
  } finally {
    removeRun(dir);
  }
}

const headerLines = (actions) => stripAnsi(actions.match(/change-header.([\s\S]*).$/)[1]).split("\n");

test("before a meaning search, the header shows the estimate, the search cap and what is left today, within a popup's width", async () => {
  const world = makeWorld({ meaning: { endpoint: "http://127.0.0.1:9/v1/systemone" } });
  try {
    recordRun(world.env.HERDR_FIND_STATE_DIR, { at: new Date().toISOString(), spend: { committed_usd: 0.0133 } });
    await picker(world, async ({ key }) => {
      const pane = headerLines(await key("meaning", [], ""));
      assert.deepEqual(pane.slice(3), ["Type what you mean, then press enter · 6 messages", "under USD 0.001 · never more than USD 0.02 per search", "USD 0.186 left today"]);
      const all = headerLines(await key("scope", ["w2-p1"]));
      assert.match(all[3], /38 messages$/);
      assert.match(all[4], /^(under USD 0\.001|about USD 0\.\d{3}) · never more than USD 0\.02 per search$/);
      assert.equal(all[5], "USD 0.186 left today");
      assert.match(pane[2], /ctrl-y copy/);
      // fzf indents each header line by 2 columns inside a popup about 76 wide with a border
      for (const line of [...pane, ...all]) assert.ok(2 + line.length <= 76 - 2, line);
    });
  } finally {
    world.cleanup();
  }
});

test("a long header line is broken between its parts, then between words, and never cut", () => {
  const line = "Searching for “what was the daily limit we agreed on” · 3 of 80 batches · 5 found · USD 0.0042 so far · ctrl-s stops";
  const lines = fitWidth(line).split("\n");
  assert.ok(lines.every((part) => part.length <= HEADER_WIDTH));
  assert.equal(lines.join(" · "), line);
  const long = fitWidth(`${"x".repeat(100)} end`, 40).split("\n");
  assert.deepEqual(long, ["x".repeat(40), "x".repeat(40), `${"x".repeat(20)} end`]);
});

test("the note that meaning search is off names its file in full, with ~ for the home folder", async () => {
  const world = makeWorld();
  try {
    const config = path.join(world.root, ".config", "herdr", "plugins", "config", "zachlandes.find");
    mkdirSync(config, { recursive: true });
    await picker({ ...world, env: { ...world.env, HERDR_FIND_CONFIG_DIR: config } }, async ({ key }) => {
      const lines = headerLines(await key("meaning", [], ""));
      assert.ok(lines.includes("~/.config/herdr/plugins/config/zachlandes.find/config.json"), lines.join("\n"));
      for (const line of lines) assert.ok(line.length <= HEADER_WIDTH, line);
    });
  } finally {
    world.cleanup();
  }
});

test("after a meaning search, the summary fits the popup and a small spend never reads as nothing", async () => {
  const world = makeWorld();
  try {
    await picker(world, async ({ dir, key, state }) => {
      await key("meaning", [], "");
      const run = { items: 1038, read: 412, stop: "search spend cap reached", refused_by_redaction: 2, failed: 1, elapsed_ms: 6100, spend: { committed_usd: 0.000017 }, caps: { day_usd: 0.2 } };
      const words = "what was the daily limit we agreed on for each workspace last week";
      const lines = stripAnsi(await headerFor(dir, state(), world.env, `${summary({ run, found: [1, 2, 3], closest: false }, words)}\nalt-m new search`)).split("\n");
      for (const line of lines) assert.ok(line.length <= HEADER_WIDTH, line);
      const shown = lines.join("\n");
      for (const part of ["stopped at the spend cap", "under USD 0.0001", "alt-m new search", "1 request failed"]) assert.ok(shown.includes(part), part);
      assert.ok(!shown.includes("USD 0.0000"));
      assert.match(summary({ run: { ...run, stop: "daily spend cap reached" }, found: [], closest: false }, words), /today's spend cap \(USD 0\.20\)/);
    });
  } finally {
    world.cleanup();
  }
});

test("the summary says the newest were read only when a cap or a stop left the oldest unread", () => {
  const run = { items: 38, read: 22, stop: null, failed: 1, refused_by_redaction: 0, elapsed_ms: 1000, spend: { committed_usd: 0.001 }, caps: { day_usd: 0.2 } };
  const failed = summary({ run, found: [1], closest: false }, "daily limit");
  assert.match(failed, /1 found in 22 of 38 messages read · 1 request failed/);
  assert.doesNotMatch(failed, /newest/);
  assert.doesNotMatch(summary({ run: { ...run, failed: 0, refused_by_redaction: 2 }, found: [1], closest: false }, "daily limit"), /newest/);
  assert.match(summary({ run: { ...run, failed: 0, stop: "search spend cap reached" }, found: [1], closest: false }, "daily limit"), /1 found in the newest 22 of 38 messages · stopped at the spend cap/);
});

test("words given when the picker opens in exact mode are searched exactly from the start", () => {
  assert.match(startActions("/x/herdr-find", "exact", "spend cap"), /rebind\(change\)\+search\('spend 'cap\)/);
  assert.doesNotMatch(startActions("/x/herdr-find", "exact", ""), /search/);
  assert.doesNotMatch(startActions("/x/herdr-find", "fuzzy", "spend cap"), /search/);
});

test("ctrl-s cycles fuzzy, exact and meaning, and the words stay in the box", async () => {
  const world = makeWorld();
  try {
    await picker(world, async ({ key, state }) => {
      const toExact = await key("cycle", [], "spend cap");
      assert.match(toExact, /change-prompt\(exact> \)/);
      assert.match(toExact, /rebind\(change\)/);
      assert.match(toExact, /search\('spend 'cap\)/);
      assert.doesNotMatch(toExact, /reload/);
      const toMeaning = await key("cycle", [], "spend cap");
      assert.match(toMeaning, /change-prompt\(meaning> \)/);
      assert.match(toMeaning, /disable-search/);
      assert.match(toMeaning, /change-query\(spend cap\)/);
      // Meaning search is off in this world, and the header says where to turn it on
      assert.match(toMeaning, /Meaning search is off\. Turn it on in/);
      const back = await key("cycle", [], "spend cap");
      assert.match(back, /change-prompt\(fuzzy> \)/);
      assert.match(back, /reload/);
      assert.match(back, /search\(spend cap\)/);
      assert.equal(state().mode, "fuzzy");
      assert.equal(await key("fuzzy", [], "x"), "ignore");
    });
  } finally {
    world.cleanup();
  }
});

test("ctrl-o goes from this pane to all open agents to the agent under the cursor", async () => {
  const world = makeWorld();
  try {
    await picker(world, async ({ key, state }) => {
      assert.match(await key("scope", ["w2-p1"]), /all open agents \(8\)/);
      assert.equal(state().scope.type, "all");
      const one = await key("scope", ["w5-p1"]);
      assert.match(one, /one agent: migrate/);
      assert.deepEqual(state().scope, { type: "agent", paneId: "w5:p1" });
      assert.match(await key("scope", ["w5-p1"]), /this pane: reviewer/);
    });
  } finally {
    world.cleanup();
  }
});

// One of the picker's own commands, as fzf runs it inside the search
const picked = (world, dir, command) => new Promise((resolve, reject) => {
  execFile(process.execPath, [BIN, command], { env: { ...world.env, HERDR_FIND_RUN: dir } }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});

test("meaning results come back from the popup's cache after fuzzy search, without asking the service again", async () => {
  const standin = await startStandin({ judge: (search, text) => (text.includes("five dollars a day") ? 0.93 : 0.05) });
  const world = makeWorld({ meaning: { endpoint: standin.url } });
  try {
    await picker(world, async ({ dir, key, state }) => {
      await key("meaning", [], "");
      await key("enter", [], "what was the daily limit");
      await picked(world, dir, "_meaning");
      const first = await picked(world, dir, "_results");
      assert.match(stripAnsi(first), /93% reviewer +claude\s+Let's cap it at five dollars a day per workspace\./);
      const asked = standin.bodies.length;
      assert.ok(asked > 0);

      assert.match(await key("cycle", [], ""), /change-prompt\(fuzzy> \)[\s\S]*change-query\(what was the daily limit\)/);
      assert.match(await key("cycle", [], "what was the daily limit"), /change-prompt\(exact> \)/);
      const again = await key("cycle", [], "what was the daily limit");
      assert.match(again, /change-prompt\(filter> \)/);
      assert.match(again, /reload\('.*' '\/x\/herdr-find' _results\)/);
      assert.match(stripAnsi(again), /“what was the daily limit”: 1 found in 6 messages/);
      assert.equal(state().phase, "results");
      assert.equal(await picked(world, dir, "_results"), first);
      assert.equal(standin.bodies.length, asked);

      // alt-m starts a new search, and enter runs it afresh even for the same words
      assert.match(await key("meaning", [], ""), /change-prompt\(meaning> \)/);
      assert.equal(state().phase, "ask");
      assert.match(await key("enter", [], "what was the daily limit"), /reload\('.*' '\/x\/herdr-find' _meaning\)/);
      assert.equal(state().phase, "running");
      await picked(world, dir, "_meaning");
      assert.ok(standin.bodies.length > asked);
    });
  } finally {
    world.cleanup();
    await standin.close();
  }
});

test("a meaning search whose requests failed is listed but not kept for coming back to", async () => {
  // The newest batch uses up its retries; the older ones, which hold the answer, succeed
  const standin = await startStandin({ judge: (search, text) => (text.includes("five dollars a day") ? 0.9 : 0.05), failFirst: 3 });
  const world = makeWorld({ meaning: { endpoint: standin.url, config: { in_flight: 1 } } });
  try {
    await picker(world, async ({ dir, key, state }) => {
      await key("scope", ["w2-p1"]);
      await key("meaning", [], "");
      await key("enter", [], "what was the daily limit");
      await picked(world, dir, "_meaning");
      const asked = standin.bodies.length;
      assert.ok(asked > 3);
      assert.match(stripAnsi(await picked(world, dir, "_results")), /90% reviewer +claude\s+Let's cap it at five dollars a day/);
      await key("cycle", [], "");
      await key("cycle", [], "what was the daily limit");
      assert.match(await key("cycle", [], "what was the daily limit"), /change-prompt\(meaning> \)/);
      assert.equal(state().phase, "ask");
      assert.match(await key("enter", [], "what was the daily limit"), /_meaning\)/);
      await picked(world, dir, "_meaning");
      assert.match(stripAnsi(await picked(world, dir, "_results")), /90%/);
      assert.ok(standin.bodies.length > asked);
    });
  } finally {
    world.cleanup();
    await standin.close();
  }
});

test("in meaning mode enter runs the search, and the words move from the box to the header", async () => {
  const standin = await startStandin({ judge: () => 0.9 });
  const world = makeWorld({ meaning: { endpoint: standin.url } });
  try {
    await picker(world, async ({ key, state }) => {
      const ask = await key("meaning", [], "what was the daily limit");
      assert.match(ask, /Type what you mean, then press enter · 6 messages\n.* · never more than USD 0\.02 per search\nUSD 0\.20 left today/);
      assert.equal(await key("enter", [], ""), "ignore");
      const run = await key("enter", [], "what was the daily limit");
      assert.match(run, /change-prompt\(filter> \)/);
      assert.match(run, /change-query\(\)/);
      assert.match(run, /Searching for “what was the daily limit”/);
      assert.match(run, /reload\('.*' '\/x\/herdr-find' _meaning\)/);
      assert.equal(state().phase, "running");
      // Leaving meaning mode brings the words back into the box
      assert.match(await key("fuzzy", [], "narrowing"), /change-query\(what was the daily limit\)/);
      assert.equal(standin.bodies.length, 0);
    });
  } finally {
    world.cleanup();
    await standin.close();
  }
});
