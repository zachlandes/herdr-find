import assert from "node:assert/strict";
import { readFileSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { shellBlocks } from "../lib/gather.mjs";
import { claudeFolder, locateTranscript, locateTranscripts, parseClaude, parsePi, piFolder, readTranscript } from "../lib/transcripts.mjs";
import { makeWorld } from "./support/world.mjs";

test("a Claude Code transcript gives what was said, without tool output or reasoning", () => {
  const world = makeWorld();
  try {
    const reviewer = world.agents.find((agent) => agent.name === "reviewer");
    const messages = parseClaude(readFileSync(reviewer.file, "utf8"));
    assert.equal(messages.length, 6);
    assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "user", "assistant", "user", "assistant"]);
    const all = messages.map((message) => message.text).join("\n");
    assert.match(all, /five dollars a day/);
    assert.doesNotMatch(all, /tool-output-only|private reasoning|git diff/);
  } finally {
    world.cleanup();
  }
});

test("a Pi transcript gives what was said, without tool results", () => {
  const world = makeWorld();
  try {
    const flaky = world.agents.find((agent) => agent.name === "flaky");
    const messages = parsePi(readFileSync(flaky.file, "utf8"));
    assert.equal(messages.length, 4);
    assert.doesNotMatch(messages.map((message) => message.text).join("\n"), /tool-output-only|private reasoning/);
  } finally {
    world.cleanup();
  }
});

test("wrappers the agent adds around typed text are dropped, and notices are skipped", () => {
  const lines = [
    { type: "user", message: { role: "user", content: "<system-reminder>internal</system-reminder>Fix the build" }, timestamp: "2026-09-25T10:00:00Z" },
    { type: "user", message: { role: "user", content: "<task-notification>done</task-notification>" } },
    { type: "user", isMeta: true, message: { role: "user", content: "meta" } },
    { type: "user", message: { role: "user", content: "<bash-input>ls</bash-input>" } }
  ].map((line) => JSON.stringify(line)).join("\n");
  assert.deepEqual(parseClaude(lines).map((message) => message.text), ["Fix the build", "! ls"]);
});

test("transcripts are found by the path or id herdr reports, else guessed from the folder", () => {
  const world = makeWorld();
  try {
    const env = world.env;
    for (const agent of world.state.agents) {
      const found = locateTranscript(agent, env);
      assert.ok(found, agent.name);
      assert.equal(found.guessed, false);
      assert.equal(readTranscript(found).length > 0, true);
    }
    // No session reported: the newest transcript in the agent's folder, marked as a guess
    const folder = path.join(env.HERDR_FIND_CLAUDE_DIR, claudeFolder("/work/guess"));
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, "old.jsonl"), "");
    writeFileSync(path.join(folder, "new.jsonl"), "");
    utimesSync(path.join(folder, "old.jsonl"), new Date(0), new Date(0));
    const guessed = locateTranscript({ agent: "claude", cwd: "/work/guess" }, env);
    assert.equal(path.basename(guessed.file), "new.jsonl");
    assert.equal(guessed.guessed, true);
    assert.equal(locateTranscript({ agent: "codex", cwd: "/work/guess" }, env), null);
  } finally {
    world.cleanup();
  }
});

test("a guess never takes the conversation another agent owns, whichever comes first", () => {
  const world = makeWorld();
  try {
    const env = world.env;
    const owner = { agent: "claude", cwd: "/work/shared", agent_session: { kind: "id", value: "owned-session" } };
    const folder = path.join(env.HERDR_FIND_CLAUDE_DIR, claudeFolder(owner.cwd));
    mkdirSync(folder, { recursive: true });
    const older = path.join(folder, "older.jsonl");
    writeFileSync(older, "");
    writeFileSync(path.join(folder, "owned-session.jsonl"), "");
    utimesSync(older, new Date(0), new Date(0));
    const newcomer = { agent: "claude", cwd: owner.cwd };
    assert.equal(locateTranscript(newcomer, env).file, locateTranscript(owner, env).file);
    const [guess, owned, second] = locateTranscripts([newcomer, owner, { ...newcomer }], env);
    assert.equal(owned.guessed, false);
    assert.equal(guess.file, older);
    assert.equal(guess.guessed, true);
    assert.equal(second, null);
  } finally {
    world.cleanup();
  }
});

test("only Claude Code and Pi conversation files are read, whatever herdr reports", () => {
  const world = makeWorld();
  try {
    const file = world.agents.find((agent) => agent.kind === "claude").file;
    assert.equal(locateTranscript({ agent: "codex", agent_session: { kind: "path", value: file } }, world.env), null);
  } finally {
    world.cleanup();
  }
});

test("folder names follow each agent's own convention", () => {
  assert.equal(claudeFolder("/Users/pat/.work/app"), "-Users-pat--work-app");
  assert.equal(piFolder("/Users/pat/.work/app"), "--Users-pat-.work-app--");
});

test("shell output is split at prompts, with colour, redraws and repeats removed", () => {
  const blocks = shellBlocks("\u001b[32m❯\u001b[0m npm test\nprogress 10%\rprogress 100%\nok\nok\n❯ git push\nerror: rejected\n\n\n");
  assert.deepEqual(blocks, ["❯ npm test\nprogress 100%\nok", "❯ git push\nerror: rejected"]);
});
