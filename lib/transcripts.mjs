import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// An agent's history comes from its own transcript, never from its pane: a full-screen agent keeps
// its history in the alternate screen, which herdr can only reach one screen at a time. The
// parsing follows Dewey's readers, keeping only what the user
// and the agent said to each other: tool calls, tool output and hidden reasoning are left out.

export function claudeRoot(env = process.env) {
  return env.HERDR_FIND_CLAUDE_DIR || path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
}

export function piRoot(env = process.env) {
  return env.HERDR_FIND_PI_DIR || path.join(env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "sessions");
}

export const claudeFolder = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, "-");
export const piFolder = (cwd) => `--${cwd.replace(/^\//, "").replace(/[/\\:]/g, "-")}--`;

const safeList = (dir) => { try { return readdirSync(dir); } catch { return []; } };

function newestJsonl(dir, taken) {
  let best = null;
  for (const name of safeList(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(dir, name);
    if (taken.has(file)) continue;
    const mtime = statSync(file).mtimeMs;
    if (!best || mtime > best.mtime) best = { file, mtime };
  }
  return best?.file ?? null;
}

function findById(root, preferred, matches) {
  const first = preferred && safeList(path.join(root, preferred)).find(matches);
  if (first) return path.join(root, preferred, first);
  for (const dir of safeList(root)) {
    const hit = safeList(path.join(root, dir)).find(matches);
    if (hit) return path.join(root, dir, hit);
  }
  return null;
}

// The transcript of one Claude Code or Pi agent in herdr's agent list: the file herdr was told
// about, else the one named by the session id herdr was told about, else the newest in the agent's
// folder that is not `taken`, which is only a guess and is marked as one
export function locateTranscript(agent, env = process.env, taken = new Set()) {
  const kind = agent.agent;
  if (kind !== "claude" && kind !== "pi") return null;
  const session = agent.agent_session;
  const cwd = agent.cwd || agent.foreground_cwd || "";
  if (session?.kind === "path" && typeof session.value === "string" && existsSync(session.value)) return { file: session.value, format: kind, guessed: false };
  if (session?.kind === "id" && typeof session.value === "string" && /^[\w-]+$/.test(session.value)) {
    const id = session.value;
    if (kind === "claude") {
      const file = findById(claudeRoot(env), cwd && claudeFolder(cwd), (name) => name === `${id}.jsonl`);
      if (file) return { file, format: "claude", guessed: false };
    } else {
      const file = findById(piRoot(env), cwd && piFolder(cwd), (name) => name.endsWith(`_${id}.jsonl`));
      if (file) return { file, format: "pi", guessed: false };
    }
  }
  if (!cwd) return null;
  const folder = kind === "claude" ? path.join(claudeRoot(env), claudeFolder(cwd)) : path.join(piRoot(env), piFolder(cwd));
  const file = newestJsonl(folder, taken);
  return file ? { file, format: kind, guessed: true } : null;
}

// Every agent's transcript, found together so a guess never takes a file another agent owns or
// has already guessed
export function locateTranscripts(agents, env = process.env) {
  const found = agents.map((agent) => locateTranscript(agent, env));
  const taken = new Set(found.filter((entry) => entry && !entry.guessed).map((entry) => entry.file));
  return found.map((entry, index) => {
    if (!entry?.guessed) return entry;
    const guess = locateTranscript(agents[index], env, taken);
    if (guess) taken.add(guess.file);
    return guess;
  });
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}

// Wrappers the agent adds around what the user typed, and whole records that are not conversation
const NOISE = /<(system-reminder|local-command-caveat|command-message|command-args|local-command-stdout|local-command-stderr)>[\s\S]*?<\/\1>/g;
const SKIPPED_STARTS = ["<task-notification>", "<bash-stdout>", "<bash-stderr>", "This session is being continued from a previous conversation", "Caveat: The messages below"];

function cleanUserText(text) {
  const trimmed = text.replace(NOISE, "").replace(/<command-name>([\s\S]*?)<\/command-name>/g, "$1").trim();
  if (!trimmed || SKIPPED_STARTS.some((start) => trimmed.startsWith(start))) return "";
  return trimmed.replace(/^<bash-input>([\s\S]*)<\/bash-input>$/, "! $1");
}

export function parseClaude(text) {
  const messages = [];
  for (const line of text.split("\n")) {
    // Most lines by size are tool results, which are never shown; skip them before parsing
    if (!line || line.includes('"type":"tool_result"') || (!line.includes('"type":"user"') && !line.includes('"type":"assistant"'))) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.isSidechain || record.isMeta || record.isCompactSummary) continue;
    const ts = record.timestamp ?? null;
    if (record.type === "user") {
      const content = record.message?.content;
      if (Array.isArray(content) && content.some((block) => block?.type === "tool_result")) continue;
      const cleaned = cleanUserText(textOf(content));
      if (cleaned) messages.push({ role: "user", ts, text: cleaned });
    } else if (record.type === "assistant") {
      const said = textOf(record.message?.content).trim();
      if (said) messages.push({ role: "assistant", ts, text: said });
    }
  }
  return messages;
}

export function parsePi(text) {
  const messages = [];
  for (const line of text.split("\n")) {
    if (!line || !line.includes('"type":"message"')) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const role = record.message?.role;
    if (record.type !== "message" || (role !== "user" && role !== "assistant")) continue;
    const said = textOf(record.message.content).trim();
    if (!said) continue;
    messages.push({ role, ts: record.timestamp ?? null, text: role === "user" ? cleanUserText(said) : said });
  }
  return messages.filter((message) => message.text);
}

export function readTranscript({ file, format }) {
  const text = readFileSync(file, "utf8");
  return format === "pi" ? parsePi(text) : parseClaude(text);
}
