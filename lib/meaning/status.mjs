import { statSync } from "node:fs";
import { loadRedactor } from "./redaction.mjs";

// Whether meaning search may send anything, and if not, the one thing to fix, in plain words.
// Only file metadata is read for the key, so this never holds the key itself.
export function meaningStatus(config, env = process.env) {
  const meaning = config.meaning;
  if (config.problem) return { ok: false, reason: `Meaning search is off: ${config.problem}` };
  if (!meaning.enabled) return { ok: false, reason: `Meaning search is off. Turn it on in ${config.file}` };
  if (!(typeof env.TYPESAFE_API_KEY === "string" && env.TYPESAFE_API_KEY.trim())) {
    let stat;
    try { stat = statSync(meaning.key_file); } catch { return { ok: false, reason: `Meaning search needs a TypeSafe key in ${meaning.key_file}` }; }
    if ((stat.mode & 0o077) !== 0) return { ok: false, reason: `Meaning search needs ${meaning.key_file} readable by you only (chmod 600)` };
    if (stat.size === 0) return { ok: false, reason: `Meaning search needs a TypeSafe key in ${meaning.key_file}; it is empty` };
  }
  try {
    loadRedactor(meaning.redaction_file);
  } catch (error) {
    return { ok: false, reason: `Meaning search needs your redaction list: ${error.message}` };
  }
  return { ok: true, reason: null };
}
