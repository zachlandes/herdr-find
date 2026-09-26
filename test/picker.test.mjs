import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { summary } from "../lib/cli.mjs";
import { act, EXACT_SHELL, exactTerms, fitWidth, fzfArgs, handleKey, headerFor, HEADER_WIDTH, startActions } from "../lib/picker.mjs";
import { stripAnsi } from "../lib/gather.mjs";
import { recordRun } from "../lib/meaning/search.mjs";
import { createRun, loadState, removeRun } from "../lib/run.mjs";
import { makeWorld } from "./support/world.mjs";
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
  assert.deepEqual(keys, ["ctrl-s", "alt-f", "alt-e", "alt-m", "ctrl-o", "enter", "alt-enter", "change", "start", "every(0.25)"]);
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
      assert.deepEqual(pane.slice(2), ["Type what you mean, then press enter · 6 messages", "under USD 0.001 · never more than USD 0.02 per search · USD 0.186 left today"]);
      const all = headerLines(await key("scope", ["w2-p1"]));
      assert.match(all[2], /38 messages$/);
      assert.match(all[3], /^(under USD 0\.001|about USD 0\.\d{3}) · never more than USD 0\.02 per search · USD 0\.186 left today$/);
      for (const line of [...pane, ...all]) assert.ok(line.length <= 76, line);
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

test("in meaning mode enter runs the search, and the words move from the box to the header", async () => {
  const standin = await startStandin({ judge: () => 0.9 });
  const world = makeWorld({ meaning: { endpoint: standin.url } });
  try {
    await picker(world, async ({ key, state }) => {
      const ask = await key("meaning", [], "what was the daily limit");
      assert.match(ask, /Type what you mean, then press enter · 6 messages\n.* · never more than USD 0\.02 per search · USD 0\.20 left today/);
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
