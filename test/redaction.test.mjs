import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRedactor, loadRedactor, RedactionError } from "../lib/meaning/redaction.mjs";

// Made-up secrets in the shapes the built-in rules look for
const SAMPLES = {
  "api key": "export OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234567890",
  bearer: "curl -H 'Authorization: Bearer abc.def-ghi_jklmnop' https://example.test",
  github: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  aws: "key AKIAABCDEFGHIJKLMNOP here",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  password: "db_password = hunter2hunter2",
  email: "mail pat@example.org about it",
  url: "postgres://admin:s3cretpass@db.internal:5432/app",
  "private key": "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----"
};

test("built-in rules remove secret shapes and keep the rest of the text", () => {
  const redactor = createRedactor();
  const out = Object.fromEntries(Object.entries(SAMPLES).map(([name, text]) => [name, redactor.redact(text)]));
  assert.equal(out["api key"], "export OPENAI_API_KEY=[api key]");
  assert.doesNotMatch(out.bearer, /abc\.def/);
  assert.equal(out.github, "token [github token]");
  assert.equal(out.aws, "key [aws key] here");
  assert.equal(out.jwt, "[token]");
  assert.equal(out.password, "db_password = [redacted]");
  assert.equal(out.email, "mail [email] about it");
  assert.equal(out.url, "postgres://[redacted]@db.internal:5432/app");
  assert.equal(out["private key"], "[private key]");
  for (const text of Object.values(out)) assert.ok(redactor.clean(text));
  assert.equal(redactor.redact("fly releases rollback v41"), "fly releases rollback v41");
});

test("the fail-closed sweep catches a secret shape whatever the rules did", () => {
  const redactor = createRedactor();
  assert.equal(redactor.clean("ghp_abcdefghijklmnopqrstuvwxyz0123456789"), false);
});

test("the user's value list applies after the built-in rules, in Dewey's format", () => {
  const redactor = createRedactor({ rules: [["name", "(?i)\\bmorgan\\b", "[person]"], ["client", "Acme (Corp)", "Client \\1"]], forbidden: ["(?i)morgan"] });
  assert.equal(redactor.redact("Ask MORGAN at Acme Corp"), "Ask [person] at Client Corp");
  assert.equal(redactor.clean("morgan"), false);
  assert.deepEqual(redactor.counts(), { name: 1, client: 1 });
});

test("a redaction list others can read is refused, and its patterns are never quoted", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "herdr-find-redaction-"));
  try {
    const file = path.join(dir, "redaction.json");
    writeFileSync(file, JSON.stringify({ rules: [], forbidden: [] }), { mode: 0o644 });
    assert.throws(() => loadRedactor(file), /chmod 600/);
    assert.throws(() => loadRedactor(path.join(dir, "missing.json")), RedactionError);
    assert.throws(() => createRedactor({ rules: [["x", "(unclosed-secret-value", "y"]], forbidden: [] }), (error) => !error.message.includes("secret-value"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
