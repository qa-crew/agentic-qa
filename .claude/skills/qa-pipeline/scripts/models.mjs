#!/usr/bin/env node
// The model each Agentic QA role runs on, for the qa-pipeline skill. Run from the project root:
//   node models.mjs [--model <id>] [--model-<role> <id>]…
// Prints { "<role>": { "model": "opus" | null, "source": "command line" | ".aiqa/ai.json" | "session", … } }.
// null = start the agent without a model override (it inherits the session's model).
import { parseModelFlags, resolveRoleModels } from "../../qa-story/scripts/aiqa-files.mjs";

const flags = parseModelFlags(process.argv.slice(2));
if (flags.unknown.length) {
  console.error(`❌ Unknown option(s): ${flags.unknown.join(", ")}. Roles: default, analyst, qa-planner, qa-engineer, qa-reviewer, qa-reporter.`);
  process.exit(1);
}
console.log(JSON.stringify(resolveRoleModels(process.cwd(), flags), null, 2));
