import path from "node:path";
import { loadConfig, stateDir } from "./config.mjs";
import { cachedResults } from "./meaning/run.mjs";
import { estimateUsd, spentInLastDay } from "./meaning/search.mjs";
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

// Two to four decimals, so a cap reads as set
export const usd = (value) => { const [whole, part] = value.toFixed(4).split("."); return `USD ${whole}.${part.replace(/0{1,2}$/, "")}`; };
const about = (value) => (value < 0.001 ? "under USD 0.001" : `about USD ${value.toFixed(3)}`);
// What was spent, never shown as nothing when anything was
export const spent = (value) => (value > 0 && value < 0.0001 ? "under USD 0.0001" : `USD ${value.toFixed(value < 0.01 ? 4 : 3)}`);
const QUOTED = 40;
export const quoted = (words) => `“${words.length > QUOTED ? `${words.slice(0, QUOTED - 1)}…` : words}”`;

// fzf cuts a header line at the popup's width rather than wrapping it, and a herdr popup is
// about 76 columns wide, so a line is broken between its parts, then between words
export const HEADER_WIDTH = 76;
export function fitWidth(line, width = HEADER_WIDTH) {
  const lines = [];
  let current = "";
  const push = () => { if (current) lines.push(current); current = ""; };
  for (const part of line.split(" · ")) {
    if (current && current.length + 3 + part.length <= width) { current += ` · ${part}`; continue; }
    push();
    for (const word of part.split(" ")) {
      if (current && current.length + 1 + word.length <= width) { current += ` ${word}`; continue; }
      push();
      current = word;
      while (current.length > width) { lines.push(current.slice(0, width)); current = current.slice(width); }
    }
  }
  push();
  return lines.join("\n");
}
const plural = (count, word) => `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;

export async function headerFor(dir, state, env, detail = null) {
  const scope = `\x1b[1m${await scopeName(dir, state, env)}\x1b[0m`;
  if (state.mode !== "meaning") return `${scope}\n${modeLine(state)}`;
  let line = detail;
  if (!line) {
    const config = loadConfig(env);
    const status = meaningStatus(config, env);
    if (!status.ok) line = status.reason;
    else {
      const chunks = await chunksFor(dir, state, env);
      const { search_cap_usd: searchCap, daily_cap_usd: dayCap } = config.meaning;
      const left = Math.max(0, dayCap - spentInLastDay(stateDir(env)));
      const estimate = Math.min(estimateUsd(chunks), searchCap, left);
      line = `Type what you mean, then press enter · ${plural(chunks.length, "message")}\n${about(estimate)} · never more than ${usd(searchCap)} per search · ${usd(Math.floor(left * 1000) / 1000)} left today`;
    }
  }
  return `${scope}\n${modeLine(state)}\n${line.split("\n").map((part) => fitWidth(part)).join("\n")}`;
}

export function summary(result, words) {
  const run = result.run;
  const seconds = `${((run.elapsed_ms ?? 0) / 1000).toFixed(1)} s`;
  if (run.stop === "daily spend cap reached") return `Meaning search has reached today's spend cap (${usd(run.caps.day_usd)}); nothing was sent`;
  const count = (value) => value.toLocaleString("en-US");
  const oldestUnread = run.stop && !run.failed && !run.refused_by_redaction;
  const read = run.read >= run.items ? `${count(run.items)} messages` : oldestUnread ? `the newest ${count(run.read)} of ${count(run.items)} messages` : `${count(run.read)} of ${count(run.items)} messages read`;
  const parts = [];
  if (result.closest) parts.push(`nothing clearly matched ${quoted(words)}; the ${result.found.length} closest are shown`);
  else parts.push(`${quoted(words)}: ${result.found.length} found in ${read}`);
  if (run.stop === "search spend cap reached") parts.push("stopped at the spend cap");
  if (run.refused_by_redaction) parts.push(`${run.refused_by_redaction} held back by your redaction list`);
  if (run.failed) parts.push(`${run.failed} request${run.failed === 1 ? "" : "s"} failed`);
  parts.push(seconds, spent(run.spend?.committed_usd ?? 0));
  return parts.join(" · ");
}

export const resultsHeader = (result, words) => `${summary(result, words)}\nalt-m new search`;

// Actions that show a finished meaning search's results, ready for typing to narrow them
async function showResults(dir, state, env, result) {
  state.phase = "results";
  saveState(dir, state);
  return [
    act("change-prompt", RESULTS_PROMPT),
    "unbind(change)",
    act("change-query", ""),
    "enable-search",
    "show-preview",
    act("reload", `${selfCommand(env.HERDR_FIND_SCRIPT)} _results`),
    act("change-header", await headerFor(dir, state, env, resultsHeader(result, state.words)))
  ].join("+");
}

// What the picker does as it opens in a mode, with the words it was given
export function startActions(script, mode, query) {
  if (mode === "meaning") return ["unbind(change)", "disable-search", "hide-preview"].join("+");
  const actions = [act("reload", `${selfCommand(script)} _items`)];
  if (mode === "exact") actions.push("rebind(change)", ...(query ? [act("search", exactTerms(query))] : []));
  else actions.push("unbind(change)");
  return actions.join("+");
}

// Actions that show a mode over the list the scope gives
async function enterMode(dir, state, mode, query, env, { reloadList, useCache = true }) {
  const self = selfCommand(env.HERDR_FIND_SCRIPT);
  const actions = [];
  const words = state.mode === "meaning" && state.phase !== "ask" ? state.words : query;
  state.mode = mode;
  state.phase = "ask";
  state.gen += 1;
  if (mode === "meaning") {
    state.words = words;
    const cached = useCache ? await cachedResults(dir, state, env) : null;
    if (cached) return showResults(dir, state, env, cached);
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
  if (key === "meaning") return state.mode === "meaning" && !showingResults ? "ignore" : enterMode(dir, state, "meaning", query, env, { reloadList, useCache: state.mode !== "meaning" });

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
        act("change-header", await headerFor(dir, state, env, `Searching for ${quoted(words)} by meaning…`)),
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
