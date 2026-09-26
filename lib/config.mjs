import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Where herdr-find keeps the user's settings and its own records. Inside a herdr plugin the
// plugin's own directories win, so an installed plugin never writes outside what herdr gave it.

export function configDir(env = process.env) {
  if (env.HERDR_FIND_CONFIG_DIR) return env.HERDR_FIND_CONFIG_DIR;
  if (env.HERDR_PLUGIN_CONFIG_DIR) return env.HERDR_PLUGIN_CONFIG_DIR;
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "herdr-find");
}

export function stateDir(env = process.env) {
  if (env.HERDR_FIND_STATE_DIR) return env.HERDR_FIND_STATE_DIR;
  if (env.HERDR_PLUGIN_STATE_DIR) return env.HERDR_PLUGIN_STATE_DIR;
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "herdr-find");
}

export const DEFAULTS = Object.freeze({
  meaning: Object.freeze({
    enabled: false,
    key_file: null,
    redaction_file: null,
    search_cap_usd: 0.02,
    daily_cap_usd: 0.2,
    in_flight: 8
  })
});

const expandHome = (value) => (typeof value === "string" && value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value);

export function loadConfig(env = process.env) {
  const dir = configDir(env);
  const file = path.join(dir, "config.json");
  let user = {};
  let problem = null;
  try {
    user = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") problem = `${file} is not valid JSON`;
  }
  const meaning = { ...DEFAULTS.meaning, ...(user.meaning ?? {}) };
  meaning.enabled = meaning.enabled === true;
  meaning.key_file = expandHome(meaning.key_file) ?? path.join(dir, "typesafe-api-key");
  meaning.redaction_file = expandHome(meaning.redaction_file) ?? path.join(dir, "redaction.json");
  for (const field of ["search_cap_usd", "daily_cap_usd"]) {
    if (!(Number.isFinite(meaning[field]) && meaning[field] > 0)) meaning[field] = DEFAULTS.meaning[field];
  }
  if (!(Number.isInteger(meaning.in_flight) && meaning.in_flight >= 1 && meaning.in_flight <= 32)) meaning.in_flight = DEFAULTS.meaning.in_flight;
  return { file, dir, problem, meaning };
}
