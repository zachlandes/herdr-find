import { listAgents, listPanes, listWorkspaces, readPane } from "./herdr.mjs";
import { locateTranscripts, readTranscript } from "./transcripts.mjs";

// Collects the text a scope covers, from the panes and agents open in herdr right now. A source is
// one pane: an agent's conversation from its transcript, or a shell's recent output.

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const stripAnsi = (text) => text.replace(ANSI, "");

// A shell prompt line starts a new stretch of output
const PROMPT = /^(?:\S+\s)?[❯➜$%#›] /;
const BLOCK_LINES = 40;

// A shell pane's output as stretches of lines, each starting at a prompt where there is one;
// carriage-return redraws keep only their last state and repeated lines collapse to one
export function shellBlocks(raw) {
  const lines = [];
  for (const line of stripAnsi(raw).split("\n")) {
    const shown = line.split("\r").filter(Boolean).pop() ?? "";
    const clean = shown.replace(/\s+$/, "");
    if (lines.length && lines[lines.length - 1] === clean) continue;
    lines.push(clean);
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (current.length && (PROMPT.test(line) || current.length >= BLOCK_LINES)) { blocks.push(current); current = []; }
    current.push(line);
  }
  if (current.length) blocks.push(current);
  return blocks.map((block) => block.join("\n").trim()).filter(Boolean);
}

export function labelFor(agent, workspaces) {
  if (agent.name) return agent.name;
  const workspace = workspaces.find((entry) => entry.workspace_id === agent.workspace_id);
  return workspace?.label ? `${agent.agent} · ${workspace.label}` : `${agent.agent} ${agent.pane_id}`;
}

// What is open in herdr right now: every pane, with the agent in it if there is one
export async function snapshot({ env = process.env } = {}) {
  const [agents, panes, workspaces] = await Promise.all([listAgents({ env }), listPanes({ env }), listWorkspaces({ env }).catch(() => [])]);
  const byPane = new Map(agents.map((agent) => [agent.pane_id, agent]));
  const transcripts = locateTranscripts(agents, env);
  const labels = new Map();
  const seen = new Map();
  for (const agent of agents) {
    let label = labelFor(agent, workspaces);
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    if (count > 1) label = `${label} ${count}`;
    labels.set(agent.pane_id, label);
  }
  return {
    agents: agents.map((agent, index) => ({ ...agent, label: labels.get(agent.pane_id), transcript: transcripts[index] })),
    panes: panes.map((pane) => ({ ...pane, agentInfo: byPane.get(pane.pane_id) ?? null })),
    focusedPaneId: panes.find((pane) => pane.focused)?.pane_id ?? null
  };
}

// One pane's source: an agent's conversation, else the shell's recent output
export async function sourceFor(paneId, snap, { env = process.env } = {}) {
  const agent = snap.agents.find((entry) => entry.pane_id === paneId);
  const pane = snap.panes.find((entry) => entry.pane_id === paneId);
  if (!agent && !pane) return null;
  const base = { paneId, tabId: agent?.tab_id ?? pane?.tab_id ?? null, isAgent: Boolean(agent) };
  if (agent) {
    const found = agent.transcript;
    if (found) {
      let messages = [];
      try { messages = readTranscript(found); } catch { /* an unreadable transcript is an empty one */ }
      return { ...base, label: agent.label, who: agent.agent, guessed: found.guessed, messages };
    }
    if (!["claude", "pi"].includes(agent.agent)) {
      // An agent whose history this tool cannot read yet is searched through what its pane shows
      return { ...base, label: agent.label, who: agent.agent, guessed: false, messages: await paneMessages(paneId, env) };
    }
    return { ...base, label: agent.label, who: agent.agent, guessed: false, missing: true, messages: [] };
  }
  return { ...base, label: pane.label || "this pane", who: "shell", guessed: false, messages: await paneMessages(paneId, env) };
}

async function paneMessages(paneId, env) {
  let raw = "";
  try { raw = await readPane(paneId, { env }); } catch { return []; }
  const now = new Date().toISOString();
  return shellBlocks(raw).map((text) => ({ role: "shell", ts: now, text }));
}

// The panes a scope covers
export function panesInScope(scope, snap, contextPaneId) {
  if (scope.type === "all") return snap.agents.map((agent) => agent.pane_id);
  if (scope.type === "agent") return [scope.paneId];
  return contextPaneId ? [contextPaneId] : [];
}
