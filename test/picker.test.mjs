import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { act, EXACT_SHELL, exactTerms, fzfArgs, handleKey, startActions } from "../lib/picker.mjs";
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

test("before a meaning search, the most it can cost is capped by what is left of today", async () => {
  const world = makeWorld({ meaning: { endpoint: "http://127.0.0.1:9/v1/systemone" } });
  try {
    recordRun(world.env.HERDR_FIND_STATE_DIR, { at: new Date().toISOString(), spend: { committed_usd: 0.1995 } });
    await picker(world, async ({ key }) => {
      assert.match(await key("scope", ["w2-p1"]), /all open agents/);
      assert.match(await key("meaning", [], ""), /up to USD 0\.0005 · caps USD 0\.02\/search, USD 0\.20\/day \(USD 0\.0005 left\)/);
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
      assert.match(ask, /Type what you mean, then press enter · 6 messages · up to USD 0\.\d+ · caps USD 0\.02\/search, USD 0\.20\/day \(USD 0\.20 left\)/);
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
