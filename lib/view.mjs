import { spawnSync } from "node:child_process";
import path from "node:path";
import { readDoc, whenOf, whoOf, writePrivate } from "./run.mjs";

// The preview beside the list, and the full document opened at a line

const PREVIEW_LINES = 400;

export function messageAt(dir, key, lineText) {
  if (!key) return {};
  const { lines, meta } = readDoc(dir, key);
  const line = Number(lineText);
  const message = meta.messages.find((entry) => line >= entry.first && line <= entry.last);
  return { lines, meta, line, message };
}

export function copyMessage(dir, key, lineText, env = process.env) {
  const { message } = messageAt(dir, key, lineText);
  if (!message) return "No message selected";
  let failed;
  for (const [command, args] of [["pbcopy", []], ["wl-copy", []], ["xclip", ["-selection", "clipboard"]]]) {
    // Original text stays on stdin, never in a shell command or display rendering
    // Stdin is always UTF-8, and pbcopy falls back to the C encoding in a popup without a locale
    const result = spawnSync(command, args, { input: message.text, env: { ...env, LC_ALL: "en_US.UTF-8" }, timeout: 5000, stdio: ["pipe", "ignore", "ignore"] });
    if (result.error?.code === "ENOENT") continue;
    if (result.status === 0) return "Copied message";
    failed = command;
  }
  return failed ? `Copy failed: ${failed}` : "Copy unavailable: install pbcopy, wl-copy or xclip";
}

export function preview(dir, key, lineText) {
  const { lines, meta, line, message } = messageAt(dir, key, lineText);
  if (!message) return "";
  const when = message.role === "shell" ? "" : whenOf(message.ts);
  const out = [`\x1b[1m${meta.label}\x1b[0m · ${whoOf(message.role, meta.who)}${when ? ` · ${when}` : ""}${meta.guessed ? " \x1b[2m(latest conversation in this folder)\x1b[0m" : ""}`, ""];
  // A very long message is shown around the line
  const from = Math.max(message.first, Math.min(line - PREVIEW_LINES / 2, message.last - PREVIEW_LINES + 1));
  const to = Math.min(message.last, from + PREVIEW_LINES - 1);
  if (from > message.first) out.push("\x1b[2m…\x1b[0m");
  for (let at = from; at <= to; at += 1) out.push(at === line ? `\x1b[7m${lines[at - 1]}\x1b[0m` : lines[at - 1]);
  if (to < message.last) out.push("\x1b[2m…\x1b[0m");
  return `${out.join("\n")}\n`;
}

// The whole conversation or pane text in the pager, at the line, which is marked
export function openAt(dir, key, lineText, env = process.env) {
  const { lines, meta } = readDoc(dir, key);
  const line = Number(lineText) || 1;
  const marked = lines.map((text, index) => (index + 1 === line ? `\x1b[7m${text}\x1b[0m` : text));
  const file = path.join(dir, "open.txt");
  writePrivate(file, [`\x1b[1m${meta.label}\x1b[0m`, "", ...marked].join("\n"));
  // Two heading lines were added above the document
  const target = line + 2;
  const pager = env.HERDR_FIND_PAGER || "less";
  // A line already on the first screen needs no jump, and jumping would pad the top with blank rows
  const rows = process.stdout.rows || 24;
  const jump = target > rows - 3 ? ["-j.3", `+${target}g`] : [];
  // less's own prompt would show the temporary file's path
  const args = pager === "less" ? ["-R", "-Ps q goes back to the search", ...jump, file] : [file];
  // A popup can start without a locale, and less then takes the text's box-drawing and middle dots for binary
  spawnSync(pager, args, { stdio: "inherit", env: { LESSCHARSET: "utf-8", ...env } });
}
