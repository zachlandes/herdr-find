#!/usr/bin/env node
// Stands in for the herdr CLI in tests: answers from the JSON file named by FAKE_HERDR_STATE, and
// appends every call to FAKE_HERDR_LOG so a test can see what was asked.
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_HERDR_LOG) appendFileSync(process.env.FAKE_HERDR_LOG, `${JSON.stringify(args)}\n`);
const state = JSON.parse(readFileSync(process.env.FAKE_HERDR_STATE, "utf8"));
const reply = (result) => process.stdout.write(`${JSON.stringify({ id: "fake", result })}\n`);

const [group, verb, target] = args;
if (group === "agent" && verb === "list") reply({ type: "agent_list", agents: state.agents });
else if (group === "pane" && verb === "list") reply({ type: "pane_list", panes: state.panes });
else if (group === "workspace" && verb === "list") reply({ type: "workspace_list", workspaces: state.workspaces ?? [] });
else if (group === "pane" && verb === "read") process.stdout.write(state.paneText?.[target] ?? "");
else if (["agent", "tab", "workspace"].includes(group) && verb === "focus") reply({ type: "ok" });
else {
  process.stderr.write(`{"error":{"code":"unknown","message":"fake herdr does not know ${group} ${verb}"}}\n`);
  process.exit(1);
}
