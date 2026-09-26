import { readFileSync, statSync } from "node:fs";

// The TypeSafe key, ported from Dewey. The returned
// object never shows the key: it is not an enumerable property, so JSON, util.inspect and a spread
// of the object all leave it out, and every error here names the source, never the value.

export class CredentialError extends Error {}

export function readTypesafeKey({ env = process.env, keyFile }) {
  let value;
  let source;
  if (typeof env.TYPESAFE_API_KEY === "string" && env.TYPESAFE_API_KEY.trim()) {
    value = env.TYPESAFE_API_KEY.trim();
    source = "env:TYPESAFE_API_KEY";
  } else {
    let stat;
    try {
      stat = statSync(keyFile);
    } catch {
      throw new CredentialError(`no TypeSafe key at ${keyFile}`);
    }
    if ((stat.mode & 0o077) !== 0) throw new CredentialError(`${keyFile} must be readable by you only (chmod 600)`);
    value = readFileSync(keyFile, "utf8").trim();
    if (!value) throw new CredentialError(`${keyFile} is empty`);
    source = `file:${keyFile}`;
  }
  const key = { source };
  Object.defineProperty(key, "authorization", { value: `Bearer ${value}`, enumerable: false });
  Object.defineProperty(key, "toJSON", { value: () => ({ source }), enumerable: false });
  return Object.freeze(key);
}
