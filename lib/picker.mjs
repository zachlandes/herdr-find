import path from "node:path";
import { loadConfig } from "./config.mjs";
import { estimateUsd } from "./meaning/jev.mjs";
import { meaningStatus } from "./meaning/status.mjs";
import { chunksFor, docKey, loadSnapshot, loadState, saveState } from "./run.mjs";

// The picker is stock fzf. Each mode and scope key runs `herdr-find _key`, which reads the
// picker's state, decides, and answers with fzf actions. The typed words are never touched by a
// mode switch, except when meaning results arrive: the box then empties so that typing narrows
// the results by letters, and the words move to the header until another mode brings them back.

export const MODES = ["fuzzy", "exact", "meaning"];
const PROMPTS = { fuzzy: "fuzzy> ", exact: "exact> ", meaning: "meaning> " };
export const RESULTS_PROMPT = "filter> ";

// An fzf action with an argument, in whichever bracket pair the argument does not contain. Only a
// header may span lines.
export function act(name, arg = "") {
  const text = name === "change-header" ? String(arg) : String(arg).replace(/[\r\n]+/g, " ");
  for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"], ["<", ">"], ["~", "~"], ["!", "!"]]) {
    if (!text.includes(close)) return `${name}${open}${text}${close}`;
  }
  return `${name}(${text.replace(/\)/g, "")})`;
}

// fzf's exact term for each word, leaving fzf's own operators alone
export function exactTerms(query) {
  return query.split(/\s+/).filter(Boolean).map((word) => (word === "|" || /^['^!]/.test(word) ? word : `'${word}`)).join(" ");
}

// The same conversion as a shell command, run on every keystroke in exact mode, where starting
// node for each key would be felt
export const EXACT_SHELL = `printf '%s' "$FZF_QUERY" | awk '{ out = ""; for (i = 1; i <= NF; i++) { w = $i; if (w != "|" && w !~ /^[\\047^!]/) w = "\\047" w; out = out (i > 1 ? " " : "") w } printf "%s", out }'`;

// Applies what a running meaning search left for the picker, if it belongs to the current search
export const TICK_SHELL = `g=$(cat "$HERDR_FIND_RUN/gen" 2>/dev/null); f="$HERDR_FIND_RUN/tick-$g"; [ -f "$f" ] && mv "$f" "$f.shown" 2>/dev/null && cat "$f.shown"`;

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
export const selfCommand = (script) => `${quote(process.execPath)} ${quote(script)}`;

export async function scopeName(dir, state, env) {
  const snap = await loadSnapshot(dir, env);
  const count = snap.agents.length;
  if (state.scope.type === "all") return `all open agents (${count})`;
  const paneId = state.scope.type === "agent" ? state.scope.paneId : state.contextPaneId;
  const agent = snap.agents.find((entry) => entry.pane_id === paneId);
  if (state.scope.type === "agent") return `one agent: ${agent?.label ?? paneId}`;
  if (!paneId) return "this pane (none found)";
  return agent ? `this pane: ${agent.label}` : "this pane";
}

function modeLine(state) {
  const marks = MODES.map((mode) => (mode === state.mode ? `\x1b[1;7m ${mode} \x1b[0m` : `\x1b[2m ${mode} \x1b[0m`)).join("");
  return `${marks}  \x1b[2mctrl-s mode · ctrl-o scope · alt-enter go there\x1b[0m`;
}

const usd = (value) => (value < 0.001 ? "under USD 0.001" : `about USD ${value.toFixed(3)}`);
const plural = (count, word) => `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;

export async function headerFor(dir, state, env, detail = null) {
  const scope = `\x1b[1m${await scopeName(dir, state, env)}\x1b[0m`;
  if (state.mode !== "meaning") return `${scope}\n${modeLine(state)}`;
  let line = detail;
  if (!line) {
    const status = meaningStatus(loadConfig(env), env);
    if (!status.ok) line = status.reason;
    else {
      const chunks = await chunksFor(dir, state, env);
      const bytes = chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.text) + 800, 0);
      line = `Type what you mean, then press enter · ${plural(chunks.length, "message")} · ${usd(estimateUsd(bytes))} at most`;
    }
  }
  return `${scope}\n${modeLine(state)}\n${line}`;
}

// Actions that show a mode over the list the scope gives
async function enterMode(dir, state, mode, query, env, { reloadList }) {
  const self = selfCommand(env.HERDR_FIND_SCRIPT);
  const actions = [];
  const words = state.mode === "meaning" && state.phase !== "ask" ? state.words : query;
  state.mode = mode;
  state.phase = "ask";
  state.gen += 1;
  if (mode === "meaning") {
    state.words = words;
    // Nothing is listed until the search runs, so there is nothing to preview either
    actions.push(act("change-prompt", PROMPTS.meaning), "unbind(change)", "disable-search", act("reload", "true"), "hide-preview", act("change-query", words));
  } else {
    actions.push(act("change-prompt", PROMPTS[mode]), "show-preview");
    if (reloadList) actions.push(act("reload", `${self} _items`));
    actions.push("enable-search");
    if (mode === "exact") actions.push("rebind(change)", act("change-query", words), act("search", exactTerms(words)));
    else actions.push("unbind(change)", act("change-query", words), act("search", words));
  }
  saveState(dir, state);
  actions.push(act("change-header", await headerFor(dir, state, env)));
  return actions.join("+");
}

export async function handleKey(dir, key, fields, env = process.env) {
  const state = loadState(dir);
  const query = env.FZF_QUERY ?? "";
  const self = selfCommand(env.HERDR_FIND_SCRIPT);
  const showingResults = state.mode === "meaning" && state.phase !== "ask";
  // Words mode lists stay loaded between fuzzy and exact; everything else reloads
  const reloadList = state.mode === "meaning";

  if (key === "cycle") return enterMode(dir, state, MODES[(MODES.indexOf(state.mode) + 1) % MODES.length], query, env, { reloadList });
  if (key === "fuzzy" || key === "exact") return state.mode === key ? "ignore" : enterMode(dir, state, key, query, env, { reloadList });
  if (key === "meaning") return state.mode === "meaning" && !showingResults ? "ignore" : enterMode(dir, state, "meaning", query, env, { reloadList });

  if (key === "scope") {
    const snap = await loadSnapshot(dir, env);
    const cursorPane = snap.panes.find((pane) => docKey(pane.pane_id) === fields[0])?.pane_id ?? null;
    const cursorIsAgent = snap.agents.some((agent) => agent.pane_id === cursorPane);
    // this pane -> all open agents -> the agent under the cursor -> this pane
    if (state.scope.type === "pane") state.scope = { type: "all" };
    else if (state.scope.type === "all" && cursorIsAgent) state.scope = { type: "agent", paneId: cursorPane };
    else state.scope = state.contextPaneId ? { type: "pane" } : { type: "all" };
    if (state.mode === "meaning") return enterMode(dir, state, "meaning", query, env, { reloadList: false });
    saveState(dir, state);
    return [act("reload", `${self} _items`), act("change-header", await headerFor(dir, state, env))].join("+");
  }

  if (key === "enter") {
    if (state.mode === "meaning" && state.phase === "ask") {
      const words = query.trim();
      if (!words) return "ignore";
      const status = meaningStatus(loadConfig(env), env);
      if (!status.ok) return act("change-header", await headerFor(dir, state, env, status.reason));
      state.words = words;
      state.phase = "running";
      state.gen += 1;
      saveState(dir, state);
      return [
        act("change-prompt", RESULTS_PROMPT),
        act("change-header", await headerFor(dir, state, env, `Searching for “${words}” by meaning…`)),
        act("change-query", ""),
        "enable-search",
        "show-preview",
        act("reload", `${self} _meaning`)
      ].join("+");
    }
    if (!fields[0]) return "ignore";
    return act("execute", `${self} _open ${quote(fields[0])} ${quote(fields[1])}`);
  }
  return "ignore";
}

export function fzfArgs({ script, state, header, startActions }) {
  const self = selfCommand(script);
  return [
    "--ansi",
    "--layout", "reverse",
    "--height", "100%",
    "--delimiter", "\t",
    "--with-nth", "3..",
    "--nth", "2",
    // The speaker and the text are separate fields so only the text is searched; a tab stop of one
    // keeps them one space apart, and no sideways scrolling keeps the agent's name in view
    "--tabstop", "1",
    "--no-hscroll",
    "--with-shell", "sh -c",
    "--info", "inline-right",
    "--prompt", state.mode === "meaning" ? PROMPTS.meaning : PROMPTS[state.mode],
    "--header", header,
    "--header-first",
    "--no-multi",
    "--scheme", "history",
    "--preview", `${self} _preview {1} {2}`,
    "--preview-window", "right,50%,wrap,<70(down,40%,wrap)",
    "--bind", `ctrl-s:transform:${self} _key cycle`,
    "--bind", `alt-f:transform:${self} _key fuzzy`,
    "--bind", `alt-e:transform:${self} _key exact`,
    "--bind", `alt-m:transform:${self} _key meaning`,
    "--bind", `ctrl-o:transform:${self} _key scope {1}`,
    "--bind", `enter:transform:${self} _key enter {1} {2}`,
    "--bind", `alt-enter:become:${self} _focus {1}`,
    "--bind", `change:transform-search:${EXACT_SHELL}`,
    "--bind", `start:${startActions}`,
    "--bind", `every(0.25):bg-transform:${TICK_SHELL}`
  ];
}

export const tickFile = (dir, gen) => path.join(dir, `tick-${gen}`);
