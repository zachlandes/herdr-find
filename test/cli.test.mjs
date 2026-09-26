import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { stripAnsi } from "../lib/gather.mjs";
import { MeaningOffError, runMeaning } from "../lib/meaning/run.mjs";
import { LEDGER_FILE, spentInLastDay } from "../lib/meaning/search.mjs";
import { createRun, loadState, removeRun } from "../lib/run.mjs";
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

async function meaningOver(world, scope, words) {
  const dir = createRun({ contextPaneId: null, scope, mode: "meaning", env: world.env });
  try {
    return await runMeaning({ dir, state: loadState(dir), words, env: world.env });
  } finally {
    removeRun(dir);
  }
}

test("meaning search is off by default and says where to turn it on, sending nothing", async () => {
  const standin = await startStandin();
  const world = makeWorld();
  try {
    await assert.rejects(meaningOver(world, { type: "all" }, "daily limit"), (error) => error instanceof MeaningOffError && /Meaning search is off\. Turn it on in .*config\.json/.test(error.message));
    assert.equal(standin.bodies.length, 0);
  } finally {
    world.cleanup();
    await standin.close();
  }
});

test("meaning search over one agent gives the ranked matches with the line to mark, and books the run", async () => {
  const standin = await startStandin({
    judge: (search, text) => (text.includes("five dollars a day") ? 0.93 : 0.05),
    pick: (search, lines) => Math.max(0, lines.findIndex((line) => line.includes("five dollars")))
  });
  const world = makeWorld({ meaning: { endpoint: standin.url } });
  try {
    const reviewer = world.state.agents.find((agent) => agent.name === "reviewer");
    const result = await meaningOver(world, { type: "agent", paneId: reviewer.pane_id }, "how much may we spend daily");
    assert.equal(result.run.read, 6);
    assert.match(stripAnsi(result.rows[0].split("\t").slice(2).join(" ")), /^ 93% reviewer +claude +Let's cap it at five dollars a day per workspace\./);
    const ledger = readFileSync(path.join(world.env.HERDR_FIND_STATE_DIR, LEDGER_FILE), "utf8");
    assert.ok(!ledger.includes("spend daily"));
    assert.equal(spentInLastDay(world.env.HERDR_FIND_STATE_DIR), result.run.spend.committed_usd);
  } finally {
    world.cleanup();
    await standin.close();
  }
});

test("there is no command that searches by meaning outside the picker", async () => {
  const world = makeWorld();
  try {
    const { code, stderr } = await run(["meaning", "daily limit"], world.env);
    assert.equal(code, 2);
    assert.match(stderr, /unknown command meaning/);
  } finally {
    world.cleanup();
  }
});

test("an agent whose conversation file this tool cannot read is searched through its pane", async () => {
  const world = makeWorld();
  try {
    const rollout = path.join(world.root, "rollout.jsonl");
    writeFileSync(rollout, `${JSON.stringify({ type: "user", message: { role: "user", content: "not a Claude line" } })}\n`);
    world.state.agents.push({ agent: "codex", name: "codex", pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", cwd: "/work/codex", agent_session: { agent: "codex", kind: "path", value: rollout } });
    writeFileSync(world.env.FAKE_HERDR_STATE, JSON.stringify(world.state));
    const { code, stdout } = await run(["list", "--scope", "agent:codex"], world.env);
    assert.equal(code, 0);
    assert.match(stdout, /codex +shell +error: failed to push some refs/);
    assert.doesNotMatch(stdout, /not a Claude line/);
  } finally {
    world.cleanup();
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

test("going to an agent brings its workspace and tab on screen before focusing it", async () => {
  const world = makeWorld();
  try {
    const { focusPane } = await import("../lib/herdr.mjs");
    const agent = world.state.agents.find((entry) => entry.name === "deploy");
    await focusPane({ ...agent, agent: true }, { env: world.env });
    const calls = readFileSync(world.env.FAKE_HERDR_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line).slice(0, 2).join(" "));
    assert.deepEqual(calls, ["workspace focus", "tab focus", "agent focus"]);
  } finally {
    world.cleanup();
  }
});
