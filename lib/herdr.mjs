import { execFile } from "node:child_process";

// Every call herdr-find makes to herdr. Inside a plugin herdr hands over HERDR_BIN_PATH and the
// socket of the right session; HERDR_FIND_HERDR overrides both, for a wrapper that targets a
// named session.

export function herdrBin(env = process.env) {
  return env.HERDR_FIND_HERDR || env.HERDR_BIN_PATH || "herdr";
}

export function herdr(args, { env = process.env, timeoutMs = 5000, json = true } = {}) {
  return new Promise((resolve, reject) => {
    execFile(herdrBin(env), args, { env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = stderr?.trim().split("\n").pop() || error.message;
        reject(new Error(`herdr ${args[0]} ${args[1] ?? ""}: ${detail}`));
        return;
      }
      if (!json) { resolve(stdout); return; }
      try {
        resolve(JSON.parse(stdout).result);
      } catch {
        reject(new Error(`herdr ${args[0]} ${args[1] ?? ""} did not answer in JSON`));
      }
    });
  });
}

export const listAgents = async (options) => (await herdr(["agent", "list"], options)).agents ?? [];
export const listPanes = async (options) => (await herdr(["pane", "list"], options)).panes ?? [];
export const listWorkspaces = async (options) => (await herdr(["workspace", "list"], options)).workspaces ?? [];

// herdr returns at most the newest 1,000 rows of a pane
export const readPane = (paneId, options) => herdr(["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "1000"], { ...options, json: false });

export async function focusPane(pane, options) {
  if (pane.agent) await herdr(["agent", "focus", pane.pane_id], options);
  else if (pane.tab_id) await herdr(["tab", "focus", pane.tab_id], options);
}

// The pane the search was opened over: a plugin popup names it in its context, a pane command
// has HERDR_PANE_ID, and failing both the focused pane stands in
export function contextPaneId(env = process.env) {
  if (env.HERDR_PLUGIN_CONTEXT_JSON) {
    try {
      const found = findPaneId(JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON));
      if (found) return found;
    } catch { /* fall through to the other sources */ }
  }
  return env.HERDR_PANE_ID || null;
}

const PANE_ID = /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/;

function findPaneId(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return null;
  for (const name of ["pane_id", "focused_pane_id", "target_pane_id"]) {
    if (typeof value[name] === "string" && PANE_ID.test(value[name])) return value[name];
  }
  for (const nested of Object.values(value)) {
    const found = findPaneId(nested, depth + 1);
    if (found) return found;
  }
  return null;
}
