import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, stateDir } from "../config.mjs";
import { chunksFor, colorFor, readDoc, styleLine, whoOf, writePrivate } from "../run.mjs";
import { readTypesafeKey } from "./credentials.mjs";
import { jevEndpoint } from "./jev.mjs";
import { loadRedactor } from "./redaction.mjs";
import { MEANING, recordRun, searchByMeaning } from "./search.mjs";
import { meaningStatus } from "./status.mjs";

export class MeaningOffError extends Error {}

// One meaning search over the documents a scope covers, turned back into picker rows, which the
// picker streams as they arrive.

const firstLine = (lines, message) => {
  for (let line = message.first; line <= message.last; line += 1) if (lines[line - 1]?.trim()) return line;
  return message.first;
};

// Where the marked line starts inside its message
function lineOf(lines, message, sentence) {
  if (!sentence) return firstLine(lines, message);
  const probe = sentence.slice(0, 40);
  for (let line = message.first; line <= message.last; line += 1) if (lines[line - 1]?.includes(probe)) return line;
  return firstLine(lines, message);
}

export function makeRowBuilder(dir, chunks) {
  const docs = new Map();
  const doc = (key) => { if (!docs.has(key)) docs.set(key, readDoc(dir, key)); return docs.get(key); };
  const labelWidth = Math.max(4, ...[...new Set(chunks.map((chunk) => chunk.key))].map((key) => Math.min(18, doc(key).meta.label.length)));
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  // A match as the line it marks, and where the marked part sits in that line
  const place = ({ id, p, sentence = null }) => {
    const chunk = byId.get(id);
    const { lines } = doc(chunk.key);
    const line = lineOf(lines, chunk.message, sentence);
    const start = sentence ? (lines[line - 1] ?? "").indexOf(sentence) : -1;
    return start >= 0 ? { id, p, line, start, end: start + sentence.length } : { id, p, line };
  };
  const toRow = ({ id, p, line, start, end }) => {
    const chunk = byId.get(id);
    const { lines, meta } = doc(chunk.key);
    const whole = lines[line - 1] ?? "";
    const text = (start === undefined ? whole : whole.slice(start, end)).trim();
    const score = `\x1b[32m${String(Math.round(p * 100)).padStart(3)}%\x1b[0m `;
    return `${chunk.key}\t${line}\t${styleLine({ lead: score, label: meta.label, labelWidth, color: colorFor(chunk.key), who: whoOf(chunk.message.role, meta.who), text })}`;
  };
  return { place, toRow };
}

// A finished search is kept in the popup's private folder until the popup closes, under the words
// and the messages it read. The picker lists the latest one from there, and coming back to meaning
// search shows it again without asking again, but only if it read everything it was asked to.
// Only ids, scores, where each marked part sits and the run's counts are kept.
const resultsFile = (dir, words, chunks) => path.join(dir, `meaning-${createHash("sha256").update(JSON.stringify([words, chunks.map((chunk) => chunk.id)])).digest("hex").slice(0, 32)}.json`);

export async function cachedResults(dir, state, env = process.env, { completeOnly = true } = {}) {
  if (!state.words) return null;
  const chunks = await chunksFor(dir, state, env);
  let saved;
  try { saved = JSON.parse(readFileSync(resultsFile(dir, state.words, chunks), "utf8")); } catch { return null; }
  if (completeOnly && !saved.complete) return null;
  const { toRow } = makeRowBuilder(dir, chunks);
  return { ...saved, rows: saved.found.map(toRow) };
}

export async function runMeaning({ dir, state, words, env = process.env, fetchImpl, onRows = () => {}, onProgress = () => {}, signal }) {
  const config = loadConfig(env);
  // Nothing is sent unless meaning search is on and has its key and redaction list
  const status = meaningStatus(config, env);
  if (!status.ok) throw new MeaningOffError(status.reason);
  const key = readTypesafeKey({ env, keyFile: config.meaning.key_file });
  const redactor = loadRedactor(config.meaning.redaction_file);
  const chunks = await chunksFor(dir, state, env);
  const { place, toRow } = makeRowBuilder(dir, chunks);
  const started = Date.now();
  const result = await searchByMeaning({
    query: words,
    items: chunks,
    key,
    redactor,
    stateDir: stateDir(env),
    capUsd: config.meaning.search_cap_usd,
    dailyCapUsd: config.meaning.daily_cap_usd,
    fetchImpl,
    endpoint: jevEndpoint(env),
    signal,
    experiment: { ...MEANING, inFlight: config.meaning.in_flight },
    onFound: (found) => onRows(found.map((entry) => toRow(place({ id: entry.item.id, p: entry.p })))),
    onProgress
  });
  result.run.elapsed_ms = Date.now() - started;
  result.run.scope = state.scope.type;
  recordRun(stateDir(env), result.run);
  const found = result.found.map(place);
  const complete = !result.run.stop && !result.run.failed && !result.run.refused_by_redaction && !signal?.aborted;
  writePrivate(resultsFile(dir, words, chunks), JSON.stringify({ complete, found, closest: result.closest, run: result.run }));
  return { ...result, found, rows: found.map(toRow) };
}
