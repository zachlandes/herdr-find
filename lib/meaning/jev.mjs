// The one place herdr-find sends anything off the machine: a meaning search request to TypeSafe's
// Jev. The spend budget, the pinned model and the retry rule are copied from Dewey, the author's
// own private tool, rather than depended on.

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const PINNED_MODEL = "jev-1.13.0";
// Output tokens are free for this model
export const JEV_PRICE = {
  model: PINNED_MODEL,
  usd_per_million_input_tokens: 0.042,
  source: "https://docs.typesafe.ai/models.md",
  checked: "2026-09-24"
};

// Dewey measured 0.246 to 0.250 billed input tokens per body byte; a third of a token per byte
// reserves more than any request used
export const RESERVE_TOKENS_PER_BYTE = 1 / 3;

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

export class SpendCapError extends Error {
  constructor(message) {
    super(message);
    this.name = "SpendCapError";
  }
}

export class ServiceError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
  }
}

export const usdFor = (tokens, price = JEV_PRICE) => (tokens * price.usd_per_million_input_tokens) / 1e6;

// Only a loopback address may stand in for TypeSafe, so a test's stand-in can never be a real host
// the key would be sent to
export function jevEndpoint(env = process.env) {
  const wanted = env.HERDR_FIND_JEV_ENDPOINT;
  if (!wanted) return JEV_ENDPOINT;
  try {
    const url = new URL(wanted);
    if (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return url.href;
  } catch { /* an unreadable address is ignored */ }
  return JEV_ENDPOINT;
}

// A spend cap enforced before every send: an attempt reserves its worst case first and is refused
// if the reservation would pass the cap. A response books its billed tokens; an attempt that may
// have reached the service without a usable answer books its reservation, since it may be billed.
// `onReserve` hears the committed total, reservations included, before each attempt is sent.
export function createSpendBudget({ capUsd, spentUsd = 0, price = JEV_PRICE, onReserve = () => {} }) {
  if (!(Number.isFinite(capUsd) && capUsd > 0)) throw new TypeError("a spend cap in USD above zero is required");
  let booked = spentUsd;
  let reserved = 0;
  let billedTokens = 0;
  let unknownAttempts = 0;
  return {
    capUsd,
    reserve(tokens) {
      const usd = usdFor(tokens, price);
      if (booked + reserved + usd > capUsd) throw new SpendCapError("spend cap reached");
      onReserve(booked + reserved + usd);
      reserved += usd;
      let open = true;
      return {
        settle(billed) {
          if (!open) return;
          open = false;
          reserved -= usd;
          if (Number.isInteger(billed) && billed >= 0) {
            booked += usdFor(billed, price);
            billedTokens += billed;
          } else {
            booked += usd;
            unknownAttempts += 1;
          }
        },
        release() {
          if (!open) return;
          open = false;
          reserved -= usd;
        }
      };
    },
    // What is committed so far, counting requests still in flight at their reservation
    committedUsd: () => booked + reserved,
    summary() {
      return { cap_usd: capUsd, committed_usd: Number((booked + reserved).toFixed(6)), billed_input_tokens: billedTokens, attempts_booked_at_reservation: unknownAttempts };
    }
  };
}

export function createResponder({ key, budget, fetchImpl = globalThis.fetch, endpoint = JEV_ENDPOINT, timeoutMs = 30000 }) {
  if (!key?.authorization) throw new TypeError("a TypeSafe key from readTypesafeKey is required");
  if (!budget) throw new TypeError("a spend budget is required");
  return async (request) => {
    if (request.model !== PINNED_MODEL) throw new ServiceError(`requests are pinned to ${PINNED_MODEL}, not ${request.model}`);
    const body = JSON.stringify(request);
    const ticket = budget.reserve(Math.ceil(Buffer.byteLength(body, "utf8") * RESERVE_TOKENS_PER_BYTE));
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { authorization: key.authorization, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      // A timeout may have been billed; a refused connection never reached the service
      if (error?.name === "TimeoutError") ticket.settle(null);
      else ticket.release();
      throw error;
    }
    if (!response.ok) {
      // A server error may have been billed; a client error such as 401 or 429 was refused
      if (response.status >= 500) ticket.settle(null);
      else ticket.release();
      // The body is not quoted: a provider error message has no place in a log line
      throw new ServiceError(`TypeSafe returned HTTP ${response.status}`, { status: response.status });
    }
    let json;
    try {
      json = await response.json();
    } catch (error) {
      ticket.settle(null);
      throw error;
    }
    ticket.settle(json?.usage?.input_tokens);
    if (json?.model !== PINNED_MODEL) throw new ServiceError(`answered by ${json?.model}, expected ${PINNED_MODEL}`);
    return json;
  };
}

export function isRetryable(error) {
  return error?.code === "ETIMEDOUT" || error?.name === "TimeoutError" || RETRYABLE_STATUSES.has(error?.status);
}

// Sends once, then retries a retryable failure with exponential backoff; an answer that fails
// validation is not retried, since asking again would pay for the same wrong shape
export async function runWithRetries({ request, send, validate, maxRetries = 2, baseDelayMs = 250, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return validate(await send(request));
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === maxRetries) break;
      await sleep(baseDelayMs * (2 ** attempt));
    }
  }
  throw lastError;
}
