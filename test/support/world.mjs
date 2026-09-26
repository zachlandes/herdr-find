import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../fixtures/build.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_HERDR = path.join(HERE, "fake-herdr.mjs");
export const BIN = path.join(HERE, "..", "..", "bin", "herdr-find");

// A herdr with the eight synthetic agents open, plus one shell pane, and an environment pointing
// every herdr-find directory into a temporary folder
export function makeWorld({ meaning = null } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "herdr-find-test-"));
  const agents = build(path.join(root, "transcripts"));
  const state = {
    workspaces: [{ workspace_id: "w1", label: "shells" }],
    agents: agents.map((agent, index) => ({
      agent: agent.kind,
      name: agent.name,
      pane_id: `w${index + 2}:p1`,
      tab_id: `w${index + 2}:t1`,
      workspace_id: `w${index + 2}`,
      cwd: agent.cwd,
      // Claude agents are found by session id, Pi agents by path, as herdr reports them
      agent_session: agent.kind === "claude" ? { agent: "claude", kind: "id", value: agent.sessionId } : { agent: "pi", kind: "path", value: agent.file }
    })),
    panes: [{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", focused: true }],
    paneText: { "w1:p1": "\u001b[32m❯\u001b[0m npm test\nok 1 - forecast tile\nok 2 - cache fallback\n❯ git push\nerror: failed to push some refs\n" }
  };
  state.panes.push(...state.agents.map((agent) => ({ pane_id: agent.pane_id, tab_id: agent.tab_id, workspace_id: agent.workspace_id, focused: false })));
  const stateFile = path.join(root, "herdr.json");
  writeFileSync(stateFile, JSON.stringify(state));
  const config = path.join(root, "config");
  mkdirSync(config, { mode: 0o700 });
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    TMPDIR: root,
    HERDR_FIND_HERDR: FAKE_HERDR,
    FAKE_HERDR_STATE: stateFile,
    FAKE_HERDR_LOG: path.join(root, "herdr-calls.log"),
    HERDR_FIND_CLAUDE_DIR: path.join(root, "transcripts"),
    HERDR_FIND_PI_DIR: path.join(root, "transcripts"),
    HERDR_FIND_CONFIG_DIR: config,
    HERDR_FIND_STATE_DIR: path.join(root, "state"),
    HERDR_FIND_RUN_ROOT: root
  };
  if (meaning) {
    writeFileSync(path.join(config, "typesafe-api-key"), "test-key-not-real\n", { mode: 0o600 });
    writeFileSync(path.join(config, "redaction.json"), JSON.stringify(meaning.redaction ?? { rules: [], forbidden: [] }), { mode: 0o600 });
    chmodSync(path.join(config, "redaction.json"), 0o600);
    writeFileSync(path.join(config, "config.json"), JSON.stringify({ meaning: { enabled: true, ...(meaning.config ?? {}) } }));
    env.HERDR_FIND_JEV_ENDPOINT = meaning.endpoint;
  }
  return { root, env, state, agents, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
