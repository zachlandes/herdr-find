import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { panesInScope, snapshot, sourceFor } from "./gather.mjs";

// One open search keeps its working files in a private temporary directory: what herdr showed when
// it opened, each pane's text as a document, the list for each scope, and the picker's state. The
// directory holds terminal text, so it is readable by the user alone and removed on exit.

export function createRun({ contextPaneId, scope, mode, env = process.env }) {
  const dir = mkdtempSync(path.join(env.HERDR_FIND_RUN_ROOT || os.tmpdir(), "herdr-find-"));
  chmodSync(dir, 0o700);
  mkdirSync(path.join(dir, "docs"), { mode: 0o700 });
  mkdirSync(path.join(dir, "items"), { mode: 0o700 });
  saveState(dir, { mode, phase: "ask", words: "", scope, contextPaneId, gen: 0, meaning: null });
  return dir;
}

export const removeRun = (dir) => rmSync(dir, { recursive: true, force: true });

export function writePrivate(file, text) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, file);
}

export const loadState = (dir) => JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));

export function saveState(dir, state) {
  writePrivate(path.join(dir, "state.json"), JSON.stringify(state));
  // The picker's timer reads the generation with a shell, so it has a file of its own
  writePrivate(path.join(dir, "gen"), String(state.gen));
}

export async function loadSnapshot(dir, env = process.env) {
  const file = path.join(dir, "snapshot.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const snap = await snapshot({ env });
  writePrivate(file, JSON.stringify(snap));
  return snap;
}

export const docKey = (paneId) => paneId.replace(/[^A-Za-z0-9]/g, "-");

const TIME = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
export const whenOf = (ts) => { const at = Date.parse(ts); return Number.isFinite(at) ? TIME.format(at) : ""; };

export const whoOf = (role, who) => (role === "user" ? "you" : role === "shell" ? "shell" : who);

// A source as a document: each message under a heading line, and where each message sits in it
export function renderDoc(source) {
  const lines = [];
  const messages = [];
  source.messages.forEach((message, index) => {
    if (lines.length) lines.push("");
    const when = whenOf(message.ts);
    lines.push(`── ${whoOf(message.role, source.who)}${when && message.role !== "shell" ? ` · ${when}` : ""}`);
    const first = lines.length + 1;
    lines.push(...message.text.replace(/\t/g, "    ").split("\n"));
    messages.push({ index, role: message.role, ts: message.ts, first, last: lines.length });
  });
  return { text: `${lines.join("\n")}\n`, meta: { paneId: source.paneId, tabId: source.tabId, isAgent: source.isAgent, label: source.label, who: source.who, guessed: source.guessed, missing: Boolean(source.missing), messages } };
}

export function readDoc(dir, key) {
  const base = path.join(dir, "docs", key);
  return { lines: readFileSync(`${base}.txt`, "utf8").split("\n"), meta: JSON.parse(readFileSync(`${base}.json`, "utf8")) };
}

export const readMeta = (dir, key) => JSON.parse(readFileSync(path.join(dir, "docs", `${key}.json`), "utf8"));

// The documents a scope covers, gathered once per open search
export async function docsInScope(dir, state, env = process.env) {
  const snap = await loadSnapshot(dir, env);
  const panes = panesInScope(state.scope, snap, state.contextPaneId);
  const keys = [];
  for (const paneId of panes) {
    const key = docKey(paneId);
    if (!existsSync(path.join(dir, "docs", `${key}.json`))) {
      const source = await sourceFor(paneId, snap, { env });
      if (!source) continue;
      const { text, meta } = renderDoc(source);
      writePrivate(path.join(dir, "docs", `${key}.txt`), text);
      writePrivate(path.join(dir, "docs", `${key}.json`), JSON.stringify(meta));
    }
    keys.push(key);
  }
  return keys;
}

const COLORS = ["36", "35", "34", "33", "32", "96", "95", "94", "93", "92"];
const MAX_LABEL = 18;

// The same agent keeps its colour whatever the scope
export function colorFor(key) {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}
const MAX_TEXT = 600;

export const clipLabel = (label) => (label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label);

export function styleLine({ label, labelWidth, color, who, text, lead = "" }) {
  const shown = clipLabel(label).padEnd(labelWidth);
  const whoStyled = who === "you" ? `\x1b[1;33m${who.padEnd(6)}\x1b[0m` : `\x1b[2m${who.padEnd(6)}\x1b[0m`;
  // The label and speaker are one field and the text another, so the search matches the text only
  return `${lead}\x1b[${color}m${shown}\x1b[0m  ${whoStyled}\t${text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text}`;
}

// Every non-empty line of every message in a scope, newest message first, as picker rows:
// document key, line number, then what is shown
export async function itemsFor(dir, state, env = process.env) {
  const keys = await docsInScope(dir, state, env);
  const docs = keys.map((key) => ({ key, color: colorFor(key), ...readDoc(dir, key) }));
  const labelWidth = Math.max(4, ...docs.map((doc) => clipLabel(doc.meta.label).length));
  const entries = [];
  for (const doc of docs) {
    for (const message of doc.meta.messages) entries.push({ doc, message, at: Date.parse(message.ts) || 0 });
  }
  // Newest first; within one agent, later messages first even without timestamps
  entries.sort((a, b) => b.at - a.at || (a.doc === b.doc ? b.message.index - a.message.index : 0));
  const rows = [];
  for (const { doc, message } of entries) {
    const who = whoOf(message.role, doc.meta.who);
    for (let line = message.first; line <= message.last; line += 1) {
      const text = doc.lines[line - 1];
      if (!text?.trim()) continue;
      rows.push(`${doc.key}\t${line}\t${styleLine({ label: doc.meta.label, labelWidth, color: doc.color, who, text: text.trim() })}`);
    }
  }
  return rows;
}

// Messages as the meaning search reads them: newest first, long ones clipped to their head and tail
const CLIP_HEAD = 4000;
const CLIP_TAIL = 1500;
export const clipForMeaning = (text) => (text.length > CLIP_HEAD + CLIP_TAIL + 500 ? `${text.slice(0, CLIP_HEAD)}\n…\n${text.slice(-CLIP_TAIL)}` : text);

export async function chunksFor(dir, state, env = process.env) {
  const keys = await docsInScope(dir, state, env);
  const chunks = [];
  for (const key of keys) {
    const { lines, meta } = readDoc(dir, key);
    for (const message of meta.messages) {
      const text = lines.slice(message.first - 1, message.last).join("\n");
      chunks.push({ id: `${key}#${message.index}`, key, message, at: Date.parse(message.ts) || 0, text: clipForMeaning(text) });
    }
  }
  chunks.sort((a, b) => b.at - a.at || (a.key === b.key ? b.message.index - a.message.index : 0));
  return chunks;
}
