import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { startStandin } from "./support/jev-standin.mjs";
import { BIN, makeWorld } from "./support/world.mjs";

const run = (args, env) => new Promise((resolve) => {
  execFile(process.execPath, [BIN, ...args], { env }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
});

test("list shows every line the agents said, newest first, and cleans up after itself", async () => {
  const world = makeWorld();
  try {
    const { code, stdout } = await run(["list", "--scope", "all"], world.env);
    assert.equal(code, 0);
    const lines = stdout.trim().split("\n");
    assert.match(lines[0], /^perf +claude The export now streams/);
    assert.ok(lines.some((line) => /^reviewer +claude Let's cap it at five dollars a day/.test(line)));
    assert.ok(!stdout.includes("tool-output-only"));
    assert.deepEqual(readdirSync(world.root).filter((name) => name.startsWith("herdr-find-")), []);
  } finally {
    world.cleanup();
  }
});

test("this pane is the focused pane when herdr names none, and a shell pane is read from the screen", async () => {
  const world = makeWorld();
  try {
    const { stdout } = await run(["list"], world.env);
    assert.match(stdout, /shell +error: failed to push some refs/);
    const agent = await run(["list", "--scope", "pane"], { ...world.env, HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ workspace_id: "w3", focused_pane: { pane_id: "w3:p1" } }) });
    assert.match(agent.stdout, /^api +claude/);
    assert.match(readFileSync(world.env.FAKE_HERDR_LOG, "utf8"), /"pane","read","w1:p1"/);
  } finally {
    world.cleanup();
  }
});

test("meaning search is off by default and says where to turn it on, sending nothing", async () => {
  const standin = await startStandin();
  const world = makeWorld();
  try {
    const { code, stderr } = await run(["meaning", "--scope", "all", "daily limit"], { ...world.env, HERDR_FIND_JEV_ENDPOINT: standin.url });
    assert.equal(code, 3);
    assert.match(stderr, /Meaning search is off\. Turn it on in .*config\.json/);
    assert.equal(standin.bodies.length, 0);
  } finally {
    world.cleanup();
    await standin.close();
  }
});

test("meaning search over one agent prints the ranked matches with the line to mark", async () => {
  const standin = await startStandin({
    judge: (search, text) => (text.includes("five dollars a day") ? 0.93 : 0.05),
    pick: (search, lines) => Math.max(0, lines.findIndex((line) => line.includes("five dollars")))
  });
  const world = makeWorld({ meaning: { endpoint: standin.url } });
  try {
    const { code, stdout, stderr } = await run(["meaning", "--scope", "agent:reviewer", "--json", "how much may we spend daily"], world.env);
    assert.equal(code, 0, stderr);
    const result = JSON.parse(stdout);
    assert.equal(result.messages, 6);
    assert.match(result.found[0], /^ 93% reviewer +claude +Let's cap it at five dollars a day per workspace\./);
    assert.equal(result.run.read, 6);
    assert.ok(!JSON.stringify(result.run).includes("spend daily"));
  } finally {
    world.cleanup();
    await standin.close();
  }
});

test("a scope naming an agent that is not open is refused", async () => {
  const world = makeWorld();
  try {
    const { code, stderr } = await run(["list", "--scope", "agent:nobody"], world.env);
    assert.equal(code, 2);
    assert.match(stderr, /no open agent called nobody/);
  } finally {
    world.cleanup();
  }
});
