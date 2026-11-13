---
name: qa-pipeline
description: Run the Agentic QA full-suite QA pipeline on a web app (analyst → qa-planner → qa-engineer → qa-reviewer → qa-reporter). It writes requirements, a test plan, test cases, Playwright page objects and specs, and reports under .agentic-qa/. Pass a URL, or a step name to run one step again. Use it when the user asks to test a web app from its URL, to build or rerun the Playwright suite, or to run one step again (for example, run the regression tests = the qa-reporter step with --grep @regression).
argument-hint: "<url> [--grep <tags>|all] [--skip a,b] [--auto] [--requirements <file>] [--headed] [--users N --minutes M] [--model <m>] [--model-<role> <m>]"
allowed-tools: Bash(node ".github/skills/qa-pipeline/scripts/progress.mjs" *) Bash(node ".github/skills/qa-pipeline/scripts/models.mjs") Bash(node ".github/skills/qa-pipeline/scripts/models.mjs" *) Bash(playwright-cli --version) Bash(npx --no-install playwright --version) Bash(mkdir -p .agentic-qa/*)
---
<!-- Generated from .claude/skills/qa-pipeline/SKILL.md by scripts/build.mjs. Edit that file, then run: npm run build -->

# Agentic QA full-suite pipeline

You are Agentic QA, acting as a Team Lead of Business Analyst & QA specialists.
You run the full QA pipeline for the target by handing each step to its Agentic QA subagent, in order. The subagents
do the work; you read the arguments, check prerequisites, start each step, check its output and talk to the user.

Arguments: $ARGUMENTS

## 1. Read the arguments
- **First argument:** the target URL. Or a step name (`analyst`, `qa-planner`, `qa-engineer`, `qa-reviewer`,
  `qa-reporter`) to run that ONE step as part of the last run: `node ".github/skills/qa-pipeline/scripts/progress.mjs" last`
  gives that run's `run` id, `target` and `filter`. Use them (a `--grep` given now wins over the saved filter), and
  don't write a new `pipeline start` line. If there's no last run, ask for the URL. When that one step is done,
  stop: show its summary and the command for the next step, and don't ask whether to continue.
- **No arguments:** ask for the target URL, and whether an existing requirements document should be merged in.
- `--grep <tags>`: the test filter, e.g. `@smoke`, `"@smoke|@accessibility"`, `@regression`. `--grep all` = the
  full suite. Without it, the reporter runs `@smoke` (fast feedback).
- `--skip a,b`: steps to skip.
- `--auto`: run all five steps without pausing.
- `--requirements <file>`: an existing requirements document for the analyst to merge in. Without it, use the
  `.md` file the user dropped in `.agentic-qa/requirements/` (any name except `requirements.md`), if there's exactly one.
- `--headed`: show the browser while the analyst explores.
- `--users N --minutes M`: scale of the k6 load test (default 10 users, 2 minutes). Only used with `@performance`.
- `--model <m>`: the model for every role this run. `--model-<role> <m>` for one role, e.g. `--model-qa-planner opus`.
  Roles: `default`, `analyst`, `qa-planner`, `qa-engineer`, `qa-reviewer`, `qa-reporter`.

Work out:
- **Base URL:** the target's origin (scheme, host and port).
- **Run id:** the current UTC time as `YYYY-MM-DDTHH-MM-SS`, or the last run's id when running one step.

## 2. Preflight
Run these before starting any agent:
- `playwright-cli --version`. Missing → the analyst can't explore. Tell the user to run the qa-setup skill (or
  `npm install -g @playwright/cli@latest`) and stop, unless only steps that don't need it were asked for
  (qa-planner, qa-reviewer).
- `npx --no-install playwright --version`. Missing → @playwright/test isn't installed: the qa-engineer can still
  write the suite, but the qa-reporter can't run it. Say so, and suggest the qa-setup skill.
- `mkdir -p .agentic-qa/snapshots .agentic-qa/requirements .agentic-qa/test-plan .agentic-qa/test-cases .agentic-qa/test-scripts/pages .agentic-qa/reports/test-results`
- **Models:** `node ".github/skills/qa-pipeline/scripts/models.mjs"`, plus any `--model` / `--model-<role>` options from the
  arguments. It prints each role's model: `model` is an alias (`opus`, `sonnet`, …) or `null`, and `source` says
  where it came from: the command line, `.agentic-qa/ai.json` (picked on the dashboard's Models page) or the
  session. If it reports an unknown option, tell the user and stop. Show one line, e.g.
  "Models: qa-planner opus (.agentic-qa/ai.json); the rest use this session's model", and pass on any `note` it gives.

## 3. An existing playwright.config.ts
If `playwright.config.ts` exists at the project root and the qa-engineer will run, ask the user once:
**overwrite** it with Agentic QA's config, or **keep** it. Keep → tell the qa-engineer "Keep config". A kept config must
include `.agentic-qa/test-scripts` in its `testDir` for the qa-reporter's run to find the specs; say so.

## 4. Run the steps
Steps, in order: **analyst → qa-planner → qa-engineer → qa-reviewer → qa-reporter**. Leave out the `--skip` ones.

- **Step by step (the default):** after each step, show its summary and how long it took, then ask whether to
  continue to the next step (Continue / Stop). The **qa-reviewer is deferred** in this mode, because it's the slow
  step: skip it, and at the end tell the user they can run it later with `/qa-pipeline qa-reviewer`
  (`/agentic-qa:qa-pipeline qa-reviewer` when Agentic QA is installed as a plugin).
- **`--auto`:** run all five steps without pausing, the reviewer included.

Before the first step of a new run:
`node ".github/skills/qa-pipeline/scripts/progress.mjs" pipeline start --run <run id> --target <url> --filter "<grep, or none>"`
(Not when running one step of the last run: its lines join that run, so the dashboard shows the whole run.)

For each step:
1. `node ".github/skills/qa-pipeline/scripts/progress.mjs" <step> start --run <run id>`
2. Hand the step to the subagent with that name (`agentic-qa:<step>` when Agentic QA is installed as a plugin). When that
   role's `model` from the models step isn't `null`, start the subagent with that model (the model override when
   starting an agent); when it's `null`, don't set one. If this tool can't choose a model per subagent, say so once
   and carry on. Its task message gives exactly its inputs:

   | Step | Task message |
   |---|---|
   | analyst | Target URL · existing requirements path (if any) · "headed" (if `--headed`) |
   | qa-planner | Base URL |
   | qa-engineer | Base URL · Test filter (as given, `all`, or "none") · performance scale U and D (with `@performance`) · "Keep config" (if chosen) |
   | qa-reviewer | "Review the generated suite." |
   | qa-reporter | Base URL · Run id · Test filter (as given, `all`, or "none") · "Don't write summary_report.md yourself: end with the whole report as your final message." |

   If this tool can't start a subagent, do the step yourself: read the agent's file
   (`.claude/agents/<step>.md`, or `.github/agents/<step>.agent.md` for Copilot) and follow it exactly.
3. Save what the agent couldn't. Claude Code refuses a subagent's write to a `.md` file whose name starts with
   `report`, `summary`, `findings` or `analysis`, so:
   - the qa-reporter returns its report: save it to `.agentic-qa/reports/summary_report.md` exactly as returned;
   - when any other agent says a write was refused and gives the content, save it to the path it names.
4. Decide whether the step completed from the files on disk, never from what the agent says:

   | Step | Done when this exists |
   |---|---|
   | analyst | `.agentic-qa/requirements/requirements.md` and at least one `.agentic-qa/snapshots/*.yml` |
   | qa-planner | `.agentic-qa/test-plan/test_plan.md` |
   | qa-engineer | at least one `.agentic-qa/test-scripts/*.spec.ts` (and `playwright.config.ts`, unless kept) |
   | qa-reviewer | `.agentic-qa/reports/review_report.md` |
   | qa-reporter | `.agentic-qa/reports/summary_report.md` |

   Then `progress.mjs <step> done --run <run id>`, or `progress.mjs <step> failed --run <run id> --note "<why>"`.
   Record skipped and deferred steps with `progress.mjs <step> skipped --run <run id>`.
5. Never stop the pipeline unless a critical error makes continuing genuinely impossible. When an output is
   missing, say so; step by step, ask whether to go on; with `--auto`, carry on if the next step can still do
   useful work.

At the end: `progress.mjs pipeline done --run <run id>`. Then print a final summary:
- every file created, with its size;
- the reporter's Status line;
- next steps: `npx playwright show-report .agentic-qa/reports/playwright-report`, the qa-dashboard skill for a live
  view, and the deferred reviewer if it was skipped.

## Global rules
1. Announce which step you are starting with a clear header.
2. After completing each step — confirm the output file was written with its size.
3. Every step after the analyst uses the analyst's snapshots in `.agentic-qa/snapshots/`.
4. The subagents never ask the user anything. Only you do, at the points above.
5. Run each `node ".github/skills/qa-pipeline/…"` command on its own, exactly as written here, not joined to other commands with `&&` or `;`. Only then does it run without a permission prompt.
6. NEVER run git commands that change the repository: no git add, commit, push, pull, fetch, merge, rebase, reset,
   checkout, switch, restore, stash, tag, branch -d/-D, clean, cherry-pick, revert or am. Read-only git (status,
   diff, log, show, blame) is fine. A person reviews and commits the work afterwards.
