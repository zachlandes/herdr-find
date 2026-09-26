import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contextPaneId, focusPane } from "./herdr.mjs";
import { MeaningOffError, runMeaning } from "./meaning/run.mjs";
import { act, fzfArgs, headerFor, handleKey, RESULTS_PROMPT, selfCommand, tickFile } from "./picker.mjs";
import { createRun, itemsFor, loadSnapshot, loadState, readMeta, removeRun, writePrivate } from "./run.mjs";
import { stripAnsi } from "./gather.mjs";
import { openAt, preview } from "./view.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "bin", "herdr-find");
const VERSION = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
// every(), bg-transform and transform-search are all in fzf 0.65
const FZF_MIN = [0, 65, 0];

const HELP = `herdr-find ${VERSION}: search what your agents in herdr said

Usage:
  herdr-find [--scope pane|all|agent:<name>] [--mode fuzzy|exact|meaning] [--pane <id>]
  herdr-find list [--scope ...]              print what would be searched
  herdr-find meaning [--scope ...] [--json] <words...>
                                             search by meaning and print the matches

In the search:
  ctrl-s      switch between fuzzy, exact and meaning search; your words stay
  alt-f alt-e alt-m   go straight to fuzzy, exact or meaning search
  ctrl-o      change what is searched: this pane, all open agents, one agent
  enter       open the line in its conversation (in meaning search, run the search first)
  alt-enter   go to that agent's pane
  esc         close

Meaning search is off until you turn it on; see the README.
`;

export function parseArgs(argv) {
  const options = { command: "search", scope: null, mode: "fuzzy", pane: null, json: false, words: [] };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith("-")) options.command = rest.shift();
  while (rest.length) {
    const arg = rest.shift();
    if (arg === "--scope") options.scope = rest.shift();
    else if (arg === "--mode") options.mode = rest.shift();
    else if (arg === "--pane") options.pane = rest.shift();
    else if (arg === "--json") options.json = true;
    else if (arg === "-h" || arg === "--help") options.command = "help";
    else if (arg === "-V" || arg === "--version") options.command = "version";
    else if (arg === "--") options.words.push(...rest.splice(0));
    else options.words.push(arg);
  }
  if (!["fuzzy", "exact", "meaning"].includes(options.mode)) throw new UsageError(`unknown mode ${options.mode}`);
  return options;
}

class UsageError extends Error {}

function resolveScope(text, snap, contextPane) {
  if (!text) return contextPane ? { type: "pane" } : { type: "all" };
  if (text === "pane") return { type: "pane" };
  if (text === "all") return { type: "all" };
  if (text.startsWith("agent:")) {
    const wanted = text.slice("agent:".length);
    const agent = snap.agents.find((entry) => entry.name === wanted || entry.label === wanted || entry.pane_id === wanted);
    if (!agent) throw new UsageError(`no open agent called ${wanted}`);
    return { type: "agent", paneId: agent.pane_id };
  }
  throw new UsageError(`unknown scope ${text}; use pane, all or agent:<name>`);
}

function checkFzf() {
  const result = spawnSync("fzf", ["--version"], { encoding: "utf8" });
  const version = result.stdout?.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  if (!version || compare(version, FZF_MIN) < 0) throw new UsageError(`herdr-find needs fzf ${FZF_MIN.join(".")} or newer on your PATH`);
}

const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// A run for one search: the pane it was opened over, and the scope to start in
async function openRun(options, env) {
  const run = createRun({ contextPaneId: null, scope: { type: "all" }, mode: options.mode, env });
  const snap = await loadSnapshot(run, env);
  const state = loadState(run);
  state.contextPaneId = options.pane || contextPaneId(env) || snap.focusedPaneId;
  state.scope = resolveScope(options.scope, snap, state.contextPaneId);
  writePrivate(path.join(run, "state.json"), JSON.stringify(state));
  return run;
}

async function interactive(options, env) {
  checkFzf();
  const run = await openRun(options, env);
  const childEnv = { ...env, HERDR_FIND_RUN: run, HERDR_FIND_SCRIPT: SCRIPT };
  const state = loadState(run);
  const self = selfCommand(SCRIPT);
  const start = state.mode === "meaning"
    ? ["unbind(change)", "disable-search", "hide-preview"]
    : [act("reload", `${self} _items`), state.mode === "exact" ? "rebind(change)" : "unbind(change)"];
  const args = fzfArgs({ script: SCRIPT, state, header: await headerFor(run, state, childEnv), startActions: start.join("+") });
  if (options.words.length) args.push("--query", options.words.join(" "));
  const code = await new Promise((resolve) => {
    const child = spawn("fzf", args, { stdio: ["pipe", "ignore", "inherit"], env: childEnv });
    child.stdin.end();
    child.on("exit", (status) => resolve(status ?? 1));
  });
  removeRun(run);
  return code === 130 ? 0 : code;
}

async function list(options, env) {
  const run = await openRun(options, env);
  try {
    for (const row of await itemsFor(run, loadState(run), env)) process.stdout.write(`${stripAnsi(row.split("\t").slice(2).join(" "))}\n`);
  } finally {
    removeRun(run);
  }
  return 0;
}

async function meaningOnce(options, env) {
  const words = options.words.join(" ").trim();
  if (!words) throw new UsageError("meaning needs words to search for");
  const run = await openRun(options, env);
  try {
    const result = await runMeaning({ dir: run, state: loadState(run), words, env });
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ found: result.rows.map((row) => stripAnsi(row.split("\t").slice(2).join(" "))), closest: result.closest, messages: result.chunks, run: result.run }, null, 2)}\n`);
    } else {
      if (result.closest) process.stdout.write("Nothing clearly matched; the closest are:\n");
      for (const row of result.rows) process.stdout.write(`${stripAnsi(row.split("\t").slice(2).join(" "))}\n`);
      process.stderr.write(`${summary(result, words)}\n`);
    }
  } finally {
    removeRun(run);
  }
  return 0;
}

const money = (value) => `USD ${value.toFixed(value < 0.01 ? 4 : 3)}`;

export function summary(result, words) {
  const run = result.run;
  const spent = money(run.spend?.committed_usd ?? 0);
  const seconds = `${((run.elapsed_ms ?? 0) / 1000).toFixed(1)} s`;
  if (run.stop === "daily spend cap reached") return `Meaning search has reached today's spend cap (USD ${run.caps.day_usd}); nothing was sent`;
  const read = run.read < run.items ? `the newest ${run.read.toLocaleString("en-US")} of ${run.items.toLocaleString("en-US")} messages` : `${run.items.toLocaleString("en-US")} messages`;
  const parts = [];
  if (result.closest) parts.push(`nothing clearly matched “${words}”; the ${result.found.length} closest are shown`);
  else parts.push(`“${words}”: ${result.found.length} found in ${read}`);
  if (run.stop === "search spend cap reached") parts.push(`stopped at the spend cap after ${read}`);
  if (run.refused_by_redaction) parts.push(`${run.refused_by_redaction} held back by your redaction list`);
  if (run.failed) parts.push(`${run.failed} requests failed`);
  parts.push(seconds, spent);
  return parts.join(" · ");
}

// The picker's own reload for a meaning search: prints matches as they arrive, and leaves the
// header and the final ranked list for the picker's timer to pick up
async function meaningReload(env) {
  const dir = env.HERDR_FIND_RUN;
  const state = loadState(dir);
  const gen = state.gen;
  const self = selfCommand(SCRIPT);
  const tick = (actions) => writePrivate(tickFile(dir, gen), actions);
  const header = async (line) => act("change-header", await headerFor(dir, state, env, line));
  const controller = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => controller.abort());
  const print = (rows) => {
    if (controller.signal.aborted) return;
    try { process.stdout.write(rows.map((row) => `${row}\n`).join("")); } catch { controller.abort(); }
  };
  process.stdout.on("error", () => controller.abort());
  try {
    const result = await runMeaning({
      dir,
      state,
      words: state.words,
      env,
      signal: controller.signal,
      onRows: print,
      onProgress: async ({ done, total, found, spentUsd }) => {
        if (controller.signal.aborted) return;
        tick(await header(`Searching for “${state.words}” · ${done} of ${total} batches · ${found} found · ${money(spentUsd)} so far · ctrl-s stops`));
      }
    });
    if (controller.signal.aborted) return 0;
    writePrivate(path.join(dir, "meaning.tsv"), result.rows.map((row) => `${row}\n`).join(""));
    const latest = loadState(dir);
    if (latest.gen === gen) { latest.phase = "results"; writePrivate(path.join(dir, "state.json"), JSON.stringify(latest)); }
    tick([await header(`${summary(result, state.words)} · alt-m new search`), act("change-prompt", RESULTS_PROMPT), act("reload", `${self} _results`)].join("+"));
  } catch (error) {
    if (!controller.signal.aborted) tick(await header(error instanceof MeaningOffError ? error.message : `Meaning search could not run: ${error.message}`));
  }
  return 0;
}

export async function main(argv, env = process.env) {
  let options;
  try {
    options = parseArgs(argv);
    switch (options.command) {
      case "help": process.stdout.write(HELP); return 0;
      case "version": process.stdout.write(`${VERSION}\n`); return 0;
      case "search": return await interactive(options, env);
      case "list": return await list(options, env);
      case "meaning": return await meaningOnce(options, env);
      // The picker's own commands, run by fzf inside a search
      case "_items": for (const row of await itemsFor(env.HERDR_FIND_RUN, loadState(env.HERDR_FIND_RUN), env)) process.stdout.write(`${row}\n`); return 0;
      case "_key": process.stdout.write(await handleKey(env.HERDR_FIND_RUN, options.words[0], options.words.slice(1), env)); return 0;
      case "_meaning": return await meaningReload(env);
      case "_results": try { process.stdout.write(readFileSync(path.join(env.HERDR_FIND_RUN, "meaning.tsv"), "utf8")); } catch { /* no results yet */ } return 0;
      case "_preview": process.stdout.write(preview(env.HERDR_FIND_RUN, options.words[0], options.words[1])); return 0;
      case "_open": if (options.words[0]) openAt(env.HERDR_FIND_RUN, options.words[0], options.words[1], env); return 0;
      case "_focus": {
        if (!options.words[0]) return 0;
        const meta = readMeta(env.HERDR_FIND_RUN, options.words[0]);
        const snap = await loadSnapshot(env.HERDR_FIND_RUN, env);
        const pane = snap.panes.find((entry) => entry.pane_id === meta.paneId);
        if (pane) await focusPane({ ...pane, agent: Boolean(pane.agentInfo) }, { env });
        return 0;
      }
      default: throw new UsageError(`unknown command ${options.command}`);
    }
  } catch (error) {
    if (error instanceof MeaningOffError) { process.stderr.write(`herdr-find: ${error.message}\n`); return 3; }
    if (error instanceof UsageError) { process.stderr.write(`herdr-find: ${error.message}\n`); return 2; }
    process.stderr.write(`herdr-find: ${error.message}\n`);
    return 1;
  }
}
