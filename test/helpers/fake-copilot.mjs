#!/usr/bin/env node
// Stand-ins for GitHub's CLIs in the dashboard's tests:
//   - as `copilot -p <prompt> --agent <step> … --output-format json`: logs what it got to .agentic-qa/fake-copilot.jsonl,
//     writes the step's output, and prints the JSONL a real Copilot run prints (test/fixtures/copilot-events.jsonl);
//   - as `gh api copilot_internal/user` (when FAKE_GH is set): a Copilot Free account with 200 chat requests left.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (process.env.FAKE_GH) {
  if (args[0] === "api" && args[1] === "copilot_internal/user") {
    process.stdout.write(JSON.stringify({ login: "someone", access_type_sku: "free_limited_copilot", copilot_plan: "individual", cli_enabled: true, quota_reset_date: "2026-12-01", quota_snapshots: { chat: { remaining: 200, unlimited: false }, premium_interactions: { remaining: 0, unlimited: false } } }));
  }
  process.exit(0);
}
// `node --test` loads every file under test/ as a test: then there's no -p, and nothing to do.
const p = args.indexOf("-p");
if (p < 0) process.exit(0);
const prompt = args[p + 1];
const agent = args.includes("--agent") ? args[args.indexOf("--agent") + 1] : undefined;
fs.mkdirSync(".agentic-qa", { recursive: true });
fs.appendFileSync(".agentic-qa/fake-copilot.jsonl", JSON.stringify({ args, prompt }) + "\n");
const w = (rel, text) => { fs.mkdirSync(path.dirname(rel), { recursive: true }); fs.writeFileSync(rel, text); };
if (agent === "analyst") {
  w(".agentic-qa/requirements/requirements.md", "# Requirements\n");
  w(".agentic-qa/snapshots/home.yml", "- heading \"Home\"\n");
} else if (agent === "qa-planner") w(".agentic-qa/test-plan/test_plan.md", "# Test plan\n");
const fixture = fileURLToPath(new URL("../fixtures/copilot-events.jsonl", import.meta.url));
process.stdout.write(fs.readFileSync(fixture, "utf-8"));
process.exit(0);
