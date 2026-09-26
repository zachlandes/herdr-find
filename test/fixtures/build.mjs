#!/usr/bin/env node
// Writes the synthetic Claude Code and Pi transcripts used by the tests and the demo. Every
// conversation here is made up, about a made-up project; no real history is committed.
//   node test/fixtures/build.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAY = "2026-09-25";

export const AGENTS = [
  {
    name: "reviewer", kind: "claude", start: "09:02",
    turns: [
      ["user", "Review the billing branch before it goes in. Focus on the usage limits."],
      ["assistant", "I read the billing branch. Two things stand out.\n\nFirst, the usage check runs after the charge is queued, so a burst of requests can go over before anything stops it.\nSecond, there is no ceiling per workspace at all, only per account."],
      ["user", "What should the ceiling be?"],
      ["assistant", "Let's cap it at five dollars a day per workspace. Anything over that waits until midnight UTC, and the owner gets an email.\nThat keeps a runaway script from costing more than a coffee."],
      ["user", "Agreed. Write that down in the PR description."],
      ["assistant", "Done. The PR description now says the daily ceiling is five dollars per workspace, reset at midnight UTC."]
    ]
  },
  {
    name: "api", kind: "claude", start: "09:40",
    turns: [
      ["user", "The weather provider keeps returning 503 during the morning rush. What do we do?"],
      ["assistant", "Retry with backoff: wait 250 ms, then 500 ms, then give up and serve the cached forecast.\nThe cache is at most ten minutes old, which is fine for a dashboard."],
      ["user", "And if the cache is empty?"],
      ["assistant", "Then the tile shows \"forecast unavailable\" instead of spinning forever. I added that state to ForecastTile and a test for it."],
      ["user", "Run the tests."],
      ["assistant", "All 212 tests pass. The new one covers the empty-cache fallback."]
    ]
  },
  {
    name: "docs", kind: "pi", start: "10:05",
    turns: [
      ["user", "Write the install section of the README."],
      ["assistant", "Install section drafted:\n\n  npm install -g tidepool\n  tidepool init\n\nIt also says the first run downloads about 30 MB of map tiles."],
      ["user", "Mention that it needs Node 20."],
      ["assistant", "Added: tidepool needs Node 20 or newer, and says so on start if the version is older."]
    ]
  },
  {
    name: "migrate", kind: "claude", start: "10:30",
    turns: [
      ["user", "We need to add the station_id column to readings without taking the site down."],
      ["assistant", "Plan: add the column as nullable, backfill, then add the constraint.\nRun the backfill in batches of 500 rows so no lock is held for more than a second."],
      ["user", "How long will the backfill take on production?"],
      ["assistant", "About 40 minutes for the 12 million rows, going by the staging run. It can run during the day because each batch is small."],
      ["user", "Ship it after lunch."],
      ["assistant", "Scheduled. The migration runs at 13:30 and posts progress to the ops channel."]
    ]
  },
  {
    name: "flaky", kind: "pi", start: "11:00",
    turns: [
      ["user", "test_daily_summary fails about once a week in CI. Find out why."],
      ["assistant", "Found it: the test fails only when the run crosses midnight, because the summary and the assertion read the clock separately.\nThe fix is to freeze time in the fixture."],
      ["user", "Freeze it where?"],
      ["assistant", "In conftest.py, the frozen_clock fixture now pins every test to 12:00 UTC. test_daily_summary uses it, and I ran it 500 times in a loop without a failure."]
    ]
  },
  {
    name: "deploy", kind: "claude", start: "11:45",
    turns: [
      ["user", "The 11:30 deploy broke the map page. Get us back."],
      ["assistant", "Rolled back with:\n\n  fly releases rollback v41\n\nThe map page loads again. The broken release changed the tile URL to http, which the browser blocks."],
      ["user", "Fix it properly and redeploy."],
      ["assistant", "Fixed the tile URL to use https and added a check that fails the build if any asset URL is plain http. v43 is live and the map loads."]
    ]
  },
  {
    name: "design", kind: "pi", start: "13:10",
    turns: [
      ["user", "The dashboard has too many colours. Pick a rule."],
      ["assistant", "Rule: teal is for primary buttons only. Everything else uses the grey scale, and red is reserved for alerts.\nThat removes four accent colours from the settings page alone."],
      ["user", "What about charts?"],
      ["assistant", "Charts get their own palette of five muted colours, checked for colour blindness, so they never compete with the teal buttons."]
    ]
  },
  {
    name: "perf", kind: "claude", start: "14:20",
    turns: [
      ["user", "The export page takes twelve seconds to load. Why?"],
      ["assistant", "Most of the time goes into parsing the 40 MB export as one JSON document before anything renders.\nStreaming it row by row gets the first rows on screen in 300 ms."],
      ["user", "Do that."],
      ["assistant", "The export now streams. First paint is 280 ms and the full table loads in 2.1 s. Memory use dropped from 900 MB to 120 MB."]
    ]
  }
];

const pad = (value) => String(value).padStart(2, "0");

function times(start, count) {
  const [hour, minute] = start.split(":").map(Number);
  return Array.from({ length: count }, (_, index) => {
    const total = hour * 60 + minute + index * 3;
    return `${DAY}T${pad(Math.floor(total / 60))}:${pad(total % 60)}:00.000Z`;
  });
}

function claudeLines(agent, sessionId, cwd) {
  const stamps = times(agent.start, agent.turns.length);
  const lines = [{ type: "permission-mode", permissionMode: "default", sessionId }];
  let parent = null;
  agent.turns.forEach(([role, text], index) => {
    const uuid = `${sessionId.slice(0, 8)}-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const message = role === "user" ? { role, content: text } : { role, model: "claude-model", content: [{ type: "thinking", thinking: "private reasoning that is never searched" }, { type: "text", text }] };
    lines.push({ parentUuid: parent, isSidechain: false, type: role, message, uuid, timestamp: stamps[index], cwd, sessionId });
    parent = uuid;
    if (role === "assistant" && index === 1) {
      // A tool call and its result, which the search leaves out
      lines.push({ parentUuid: parent, isSidechain: false, type: "assistant", message: { role, content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "git diff" } }] }, uuid: `${uuid}-t`, timestamp: stamps[index], sessionId });
      lines.push({ parentUuid: parent, isSidechain: false, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "diff --git a/tool-output-only b/tool-output-only" }] }, uuid: `${uuid}-r`, timestamp: stamps[index], sessionId });
    }
  });
  return lines;
}

function piLines(agent, sessionId, cwd) {
  const stamps = times(agent.start, agent.turns.length);
  const lines = [{ type: "session", version: 3, id: sessionId, timestamp: stamps[0], cwd }];
  let parent = null;
  agent.turns.forEach(([role, text], index) => {
    const id = `${sessionId.slice(0, 6)}${index}`;
    const content = role === "user" ? [{ type: "text", text }] : [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text }];
    lines.push({ type: "message", id, parentId: parent, timestamp: stamps[index], message: { role, content, timestamp: Date.parse(stamps[index]) } });
    parent = id;
    if (role === "assistant" && index === 1) {
      lines.push({ type: "message", id: `${id}t`, parentId: parent, timestamp: stamps[index], message: { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "tool-output-only" }], isError: false } });
    }
  });
  return lines;
}

export function build(root = path.join(HERE, "transcripts")) {
  const out = [];
  AGENTS.forEach((agent, index) => {
    const sessionId = `0000000${index}-aaaa-4bbb-8ccc-${String(index).padStart(12, "0")}`;
    const cwd = `/work/tidepool-${agent.name}`;
    const dir = path.join(root, agent.kind);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, agent.kind === "pi" ? `${DAY}T00-00-00-000Z_${sessionId}.jsonl` : `${sessionId}.jsonl`);
    const lines = agent.kind === "pi" ? piLines(agent, sessionId, cwd) : claudeLines(agent, sessionId, cwd);
    writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    out.push({ ...agent, sessionId, cwd, file });
  });
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const agent of build()) process.stdout.write(`${path.relative(process.cwd(), agent.file)}\n`);
}
