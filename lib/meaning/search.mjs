import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { createResponder, createSpendBudget, ESTIMATE_TOKENS_PER_BYTE, JEV_ENDPOINT, PINNED_MODEL, runWithRetries, usdFor } from "./jev.mjs";
import { makeMeaningQuestion, makeSentenceQuestion, MEANING_PROMPT, SENTENCE_PROMPT } from "./prompts.mjs";

// Search by meaning, ported from Dewey, which
// follows Needle (Shubham Saboo, awesome-llm-apps, Apache-2.0): each item is asked whether it is
// directly useful to what the user searched for, and each match is then asked which one line to
// mark. Unlike Dewey, results are ranked, best first, and are reported batch by batch as they
// arrive so the picker can show them while the rest are still being judged.
//
// Items are read newest first, so when a search reaches its cap it is the oldest that go unread.
// Every text is redacted before it is sent and a body that fails the redaction check is never
// sent. The runs ledger records counts and cost, never the words searched for or any item text.

export const MEANING = Object.freeze({
  prompt: MEANING_PROMPT,
  sentencePrompt: SENTENCE_PROMPT,
  model: PINNED_MODEL,
  // Needle's threshold, a starting point until searches on terminal history are scored
  floor: 0.58,
  // When nothing reaches the floor, the few nearest are shown and said to be only the closest
  closest: 3,
  // Items per request, and the text a request may carry; Jev answers a request's questions in parallel
  batch: 16,
  batchChars: 24000,
  inFlight: 4,
  maxItems: 5000,
  maxQueryChars: 400,
  // A choice holds at most 255 options; an item longer than this is marked in its first lines
  maxSentences: 60,
  // Only the best matches get a line picked, since each pick is one more request
  maxSentencePicks: 20
});

export const LEDGER_FILE = "meaning-runs.jsonl";

// An item's lines as they appear in it, so the one Jev picks can be found again
export function sentencesOf(text) {
  return text.split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter((part) => part.length >= 3 && /\w/.test(part));
}

// Batches of items that each fit in one request
export function batchesOf(items, { batch = MEANING.batch, batchChars = MEANING.batchChars } = {}) {
  const out = [];
  let current = [];
  let chars = 0;
  for (const item of items) {
    const size = item.text.length;
    if (current.length && (current.length >= batch || chars + size > batchChars)) { out.push(current); current = []; chars = 0; }
    current.push(item);
    chars += size;
  }
  if (current.length) out.push(current);
  return out;
}

// The items a search reads: those with text, newest first, up to its limit
const askedOf = (items, experiment) => items.filter((item) => item.text?.trim()).slice(0, experiment.maxItems);

const bodyBytes = (request) => Buffer.byteLength(JSON.stringify(request), "utf8");

// About what a search over these items costs before its caps, at the measured rate: each batch with
// the longest search allowed, and a line picked in each of the longest items. Only the caps bound it,
// since a retried request is charged again.
export function estimateUsd(items, experiment = MEANING) {
  const asked = askedOf(items, experiment);
  const query = "x".repeat(experiment.maxQueryChars);
  let bytes = 0;
  for (const batch of batchesOf(asked, experiment)) bytes += bodyBytes(buildMeaningRequest(query, batch));
  const longest = [...asked].sort((a, b) => b.text.length - a.text.length).slice(0, experiment.maxSentencePicks);
  for (const item of longest) bytes += bodyBytes(buildSentenceRequest(query, item, sentencesOf(item.text).slice(0, experiment.maxSentences)));
  return usdFor(Math.ceil(bytes * ESTIMATE_TOKENS_PER_BYTE));
}

// Request-local ids, so no pane, session or file name goes into a body
export function buildMeaningRequest(query, items, { redact = (text) => text } = {}) {
  const ids = items.map((_, index) => `i${index + 1}`);
  return {
    state: { search: redact(query), items: Object.fromEntries(items.map((item, index) => [ids[index], redact(item.text)])) },
    model: MEANING.model,
    questions: Object.fromEntries(ids.map((id) => [id, makeMeaningQuestion(id)]))
  };
}

export function buildSentenceRequest(query, item, sentences, { redact = (text) => text } = {}) {
  return {
    state: { search: redact(query), item: redact(item.text) },
    model: MEANING.model,
    questions: { focus: makeSentenceQuestion(sentences.map(redact)) }
  };
}

function validateMeaning(response, request) {
  const answers = response?.answers;
  if (!answers || typeof answers !== "object") throw new Error("response has no answers");
  for (const id of Object.keys(request.questions)) {
    const answer = answers[id];
    if (answer?.type !== "noul" || typeof answer.noul !== "number" || answer.noul < 0 || answer.noul > 1) throw new Error(`answer ${id} is not a probability`);
  }
  if (!Number.isInteger(response?.usage?.input_tokens)) throw new Error("response has no token count");
  return response;
}

function validateSentence(response, request) {
  const answer = response?.answers?.focus;
  if (answer?.type !== "choice" || !(answer.choice in request.questions.focus.criteria)) throw new Error("the line is not one of its options");
  return response;
}

// Runs at most `limit` jobs at once, in order of starting
async function pool(items, limit, job) {
  let next = 0;
  const worker = async () => { while (next < items.length) { const index = next; next += 1; await job(items[index], index); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// USD booked by runs in the last 24 hours, from the ledger. A run is booked as it spends and again
// when it ends, and only its last line counts, so a search killed midway still counts.
export function spentInLastDay(stateDir, now = new Date()) {
  const since = now.getTime() - 24 * 3600 * 1000;
  const byRun = new Map();
  for (const [index, line] of ledgerSince(path.join(stateDir, LEDGER_FILE), since).entries()) {
    if (!line) continue;
    try {
      const run = JSON.parse(line);
      if (Date.parse(run.at) >= since) byRun.set(run.run_id ?? index, run.spend?.committed_usd ?? 0);
    } catch { /* a torn line is skipped */ }
  }
  let total = 0;
  for (const usd of byRun.values()) total += usd;
  return total;
}

// The ledger's lines from the end back to one written well before `since`. Lines are appended as
// runs spend, and each carries its run's start, so a line older than the window by more than any
// search lasts marks where nothing earlier can count.
const LEDGER_CHUNK = 64 * 1024;
const LEDGER_MARGIN_MS = 3600 * 1000;
function ledgerSince(file, since) {
  let fd;
  try { fd = openSync(file, "r"); } catch { return []; }
  try {
    const chunks = [];
    let start = fstatSync(fd).size;
    while (start > 0) {
      const end = start;
      start = Math.max(0, end - LEDGER_CHUNK);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      chunks.unshift(chunk);
      const whole = chunk.toString("utf8").split("\n")[1];
      try { if (start > 0 && Date.parse(JSON.parse(whole).at) < since - LEDGER_MARGIN_MS) break; } catch { /* keep reading */ }
    }
    const lines = Buffer.concat(chunks).toString("utf8").split("\n");
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    closeSync(fd);
  }
}

export function recordRun(stateDir, run) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  appendFileSync(path.join(stateDir, LEDGER_FILE), `${JSON.stringify(run)}\n`, { mode: 0o600 });
}

// `items` are { id, text } newest first. `onFound` hears each batch's matches as they arrive.
// Resolves to every item judged, ranked, with how sure Jev was and the line to mark, and the run
// as it should be recorded. `signal` stops sending new requests; requests in flight still settle.
export async function searchByMeaning({ query, items, key, redactor, stateDir, capUsd, dailyCapUsd, fetchImpl, endpoint = JEV_ENDPOINT, now = new Date(), retry = { maxRetries: 2, baseDelayMs: 250 }, sleep, onFound = () => {}, onProgress = () => {}, signal, experiment = MEANING }) {
  if (typeof query !== "string" || !query.trim()) throw new TypeError("a search needs words");
  const words = query.trim().slice(0, experiment.maxQueryChars);
  const withText = items.filter((item) => item.text?.trim());
  const asked = askedOf(withText, experiment);
  const run = {
    run_id: `meaning-${randomUUID()}`,
    at: now.toISOString(),
    prompt: experiment.prompt,
    sentence_prompt: experiment.sentencePrompt,
    model: experiment.model,
    floor: experiment.floor,
    query_chars: words.length,
    items: withText.length,
    read: 0,
    requests: 0,
    batches: 0,
    matches: 0,
    closest: false,
    refused_by_redaction: 0,
    failed: 0,
    caps: null,
    stop: null
  };
  const available = Math.min(capUsd, dailyCapUsd - spentInLastDay(stateDir, now));
  run.caps = { search_usd: capUsd, day_usd: dailyCapUsd, available_usd: Number(Math.max(0, available).toFixed(6)) };
  const batches = batchesOf(asked, experiment);
  run.batches = batches.length;
  if (!(available > 1e-6)) {
    run.stop = "daily spend cap reached";
    run.spend = { cap_usd: 0, committed_usd: 0, billed_input_tokens: 0, attempts_booked_at_reservation: 0 };
    return { found: [], closest: false, read: 0, run };
  }
  const budget = createSpendBudget({
    capUsd: available,
    onReserve: (committedUsd) => recordRun(stateDir, { run_id: run.run_id, at: run.at, spend: { committed_usd: Number(committedUsd.toFixed(6)) } })
  });
  const responder = createResponder({ key, budget, fetchImpl, endpoint });
  const redact = (text) => redactor.redact(text);
  const send = async (request, validate) => {
    if (!redactor.clean(JSON.stringify(request.state)) || !redactor.clean(JSON.stringify(request.questions))) { run.refused_by_redaction += 1; return null; }
    run.requests += 1;
    try {
      return await runWithRetries({ request, send: responder, validate: (response) => validate(response, request), ...retry, sleep });
    } catch (error) {
      if (error?.name === "SpendCapError") run.stop ??= "search spend cap reached";
      else run.failed += 1;
      return null;
    }
  };
  const stopped = () => run.stop || signal?.aborted;

  // How sure Jev is that each item answers the search
  const scored = [];
  let done = 0;
  await pool(batches, experiment.inFlight, async (batch) => {
    if (stopped()) return;
    const response = await send(buildMeaningRequest(words, batch, { redact }), validateMeaning);
    done += 1;
    if (response) {
      const judged = batch.map((item, index) => ({ item, p: response.answers[`i${index + 1}`].noul }));
      scored.push(...judged);
      const passing = judged.filter((entry) => entry.p >= experiment.floor).sort((a, b) => b.p - a.p);
      if (passing.length) onFound(passing);
    }
    onProgress({ done, total: batches.length, read: scored.length, found: scored.filter((entry) => entry.p >= experiment.floor).length, spentUsd: budget.committedUsd() });
  });
  if (signal?.aborted) run.stop ??= "stopped";
  scored.sort((a, b) => b.p - a.p);
  let found = scored.filter((entry) => entry.p >= experiment.floor);
  const closest = !found.length && scored.length > 0;
  if (closest) found = scored.slice(0, experiment.closest);

  // Then which line of each of the best to mark
  await pool(found.slice(0, experiment.maxSentencePicks), experiment.inFlight, async (entry) => {
    const sentences = sentencesOf(entry.item.text).slice(0, experiment.maxSentences);
    if (sentences.length <= 1) { entry.sentence = sentences[0] ?? null; return; }
    if (stopped()) return;
    const response = await send(buildSentenceRequest(words, entry.item, sentences, { redact }), validateSentence);
    entry.sentence = response ? sentences[Number(response.answers.focus.choice.slice(1))] : null;
  });
  run.read = scored.length;
  run.matches = closest ? 0 : found.length;
  run.closest = closest;
  run.spend = budget.summary();
  run.redaction = redactor.counts();
  return { found: found.map((entry) => ({ id: entry.item.id, p: Number(entry.p.toFixed(3)), sentence: entry.sentence ?? null })), closest, read: scored.length, run };
}
