#!/usr/bin/env node
// A stand-in for `claude -p --agent <step>` in the dashboard's run tests. It reads the task message from stdin, logs
// what it got to .agentic-qa/fake-claude.jsonl, writes the step's output, and prints stream-json like the real CLI.
//   A target containing "fail.example" exits 1 without writing; "slow.example" (or FAKE_CLAUDE_SLOW=1, for demos)
//   waits until it's stopped.
import * as fs from "node:fs";
import * as path from "node:path";

const args = process.argv.slice(2);
// `claude auth status --json`: signed in to Claude Pro unless FAKE_CLAUDE_SIGNED_OUT is set. The email is there to
// check it never reaches the page.
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(JSON.stringify(process.env.FAKE_CLAUDE_SIGNED_OUT ? { loggedIn: false } : { loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro", email: "someone@example.com", orgName: "Someone's Org" }));
  process.exit(0);
}
// `node --test` loads every file under test/ as a test: then there's no -p, and nothing to do.
if (!args.includes("-p")) process.exit(0);
const agent = args.includes("--agent") ? args[args.indexOf("--agent") + 1] : undefined;
let prompt = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (c) => (prompt += c));
process.stdin.on("end", () => {
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(rel), { recursive: true });
    fs.writeFileSync(rel, text);
  };
  fs.mkdirSync(".agentic-qa", { recursive: true });
  fs.appendFileSync(".agentic-qa/fake-claude.jsonl", JSON.stringify({ args, prompt }) + "\n");
  const out = (e) => process.stdout.write(JSON.stringify(e) + "\n");
  out({ type: "system", subtype: "init", session_id: "fake" });
  out({ type: "assistant", message: { content: [{ type: "text", text: `Working as ${agent ?? "the main session"}.` }, { type: "tool_use", name: "Bash", input: { command: "playwright-cli snapshot" } }] } });
  out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: `${process.cwd()}/.agentic-qa/notes.md`, content: "x" } }, { type: "tool_use", name: "Task", input: { description: "Explore the cart", subagent_type: "general-purpose" } }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", is_error: true, content: "Permission to use Bash(rm -rf x) was denied." }] } });
  if (prompt.includes("slow.example") || process.env.FAKE_CLAUDE_SLOW) return setTimeout(() => {}, 600_000);
  if (prompt.includes("fail.example")) {
    out({ type: "result", subtype: "error_during_execution", is_error: true, result: "" });
    process.exit(1);
  }
  if (agent === "analyst") {
    w(".agentic-qa/requirements/requirements.md", "# Requirements\n");
    w(".agentic-qa/snapshots/home.yml", "- heading \"Home\"\n");
  } else if (agent === "qa-planner") w(".agentic-qa/test-plan/test_plan.md", "# Test plan\n");
  else if (agent === "qa-engineer") w(".agentic-qa/test-scripts/home.spec.ts", "// spec\n");
  else if (agent === "qa-reviewer") w(".agentic-qa/reports/review_report.md", "# Review\n");
  out({ type: "result", subtype: "success", is_error: false, duration_ms: 1200, total_cost_usd: 0.05, usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 3000, cache_creation_input_tokens: 500 }, result: agent === "qa-reporter" ? "# Summary report\n\nStatus: all passed." : "Done." });
  process.exit(0);
});
