import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fzfArgs } from "../lib/picker.mjs";
import { createRun, removeRun, renderDoc, writePrivate } from "../lib/run.mjs";
import { preview } from "../lib/view.mjs";
import { BIN, makeWorld } from "./support/world.mjs";

function fixture(world, text) {
  const dir = createRun({ contextPaneId: null, scope: { type: "all" }, mode: "fuzzy", env: world.env });
  const doc = renderDoc({ paneId: "p", label: "test", who: "claude", messages: [{ role: "assistant", text }] });
  writePrivate(path.join(dir, "docs", "p.txt"), doc.text);
  writePrivate(path.join(dir, "docs", "p.json"), JSON.stringify(doc.meta));
  return dir;
}

for (const tool of ["pbcopy", "wl-copy", "xclip", null, "failed"]) {
  test(`copy binding sends original message to ${tool ?? "no installed clipboard"}`, () => {
    const world = makeWorld();
    const sentinel = path.join(world.root, "must-not-exist");
    const text = `  tabs\tstay\r\n$(touch '${sentinel}')\n\`touch '${sentinel}'\` 'quotes' $HOME\n${"long line ".repeat(100)}\n${"more\n".repeat(450)}\n`;
    const dir = fixture(world, text);
    try {
      const bin = path.join(world.root, "clipboard-bin");
      mkdirSync(bin);
      const output = path.join(world.root, "clipboard");
      const argsFile = path.join(world.root, "args");
      if (tool) writeFileSync(path.join(bin, tool === "failed" ? "pbcopy" : tool), `#!/bin/sh\n${tool === "failed" ? "exit 1" : '/bin/cat > "$COPY_OUTPUT"\nprintf "%s\\n" "$@" > "$COPY_ARGS"'}\n`, { mode: 0o755 });
      const env = { ...world.env, HERDR_FIND_RUN: dir, PATH: bin, COPY_OUTPUT: output, COPY_ARGS: argsFile };
      const args = fzfArgs({ script: BIN, state: { mode: "fuzzy" }, header: "", startActions: "ignore" });
      const binding = args.find((arg) => arg.startsWith("ctrl-y:"));
      assert.ok(binding);
      assert.equal(args.filter((arg) => arg.startsWith("ctrl-y:")).length, 1);
      const [, execute, transform] = binding.match(/^ctrl-y:execute-silent\((.*)\)\+transform\((.*)\)$/);
      const copied = spawnSync("/bin/sh", ["-c", execute.replace("{1}", "'p'").replace("{2}", "'3'")], { env, encoding: "utf8" });
      assert.equal(copied.status, 0, copied.stderr);
      const notice = spawnSync("/bin/sh", ["-c", transform], { env, encoding: "utf8" });
      assert.equal(notice.status, 0, notice.stderr);
      assert.equal(existsSync(sentinel), false);
      if (tool && tool !== "failed") {
        assert.deepEqual(readFileSync(output), Buffer.from(text));
        assert.equal(notice.stdout, "change-preview-label(Copied message)");
        if (tool === "xclip") assert.equal(readFileSync(argsFile, "utf8"), "-selection\nclipboard\n");
        assert.ok(!preview(dir, "p", "3").includes("tabs\tstay"));
      } else {
        assert.equal(existsSync(output), false);
        assert.match(notice.stdout, tool ? /Copy failed: pbcopy/ : /Copy unavailable: install pbcopy, wl-copy or xclip/);
      }
      const empty = spawnSync(process.execPath, [BIN, "_copy"], { env, encoding: "utf8" });
      assert.equal(empty.status, 0);
      assert.equal(readFileSync(path.join(dir, "copy-status"), "utf8"), "change-preview-label(No message selected)");
    } finally {
      removeRun(dir);
      world.cleanup();
    }
  });
}
