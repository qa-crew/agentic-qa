#!/usr/bin/env node
// Progress lines for the AIQA dashboard, written by the qa-pipeline skill. Run from the project root:
//   node progress.mjs <step> <event> [--run <id>] [--target <url>] [--filter <tags>] [--note <text>]
//     step:  pipeline | analyst | qa-planner | qa-engineer | qa-reviewer | qa-reporter
//     event: start | done | failed | skipped | paused
//   node progress.mjs last      the last full-suite run's { run, target, filter } as JSON
import * as fs from "node:fs";
import * as path from "node:path";

const file = path.join(process.cwd(), ".aiqa", "progress.jsonl");
const [, , step, event, ...rest] = process.argv;
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

if (step === "last") {
  let last = {};
  try {
    for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
      try {
        const e = JSON.parse(line);
        if (e.kind === "suite" && e.step === "pipeline" && e.event === "start") last = { run: e.run, target: e.target, filter: e.filter };
      } catch {}
    }
  } catch {}
  console.log(JSON.stringify(last));
  process.exit(last.target ? 0 : 2);
}

if (!step || !event) {
  console.error("Usage: node progress.mjs <step> <event> [--run <id>] [--target <url>] [--filter <tags>] [--note <text>]");
  process.exit(1);
}
fs.mkdirSync(path.dirname(file), { recursive: true });
const entry = { ts: new Date().toISOString(), kind: "suite", step, event, run: flag("run"), target: flag("target"), filter: flag("filter"), note: flag("note") };
fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
