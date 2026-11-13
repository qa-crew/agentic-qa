# AIQA agents

AIQA's QA agents for **Claude Code** and **GitHub Copilot**. Give them a URL and they produce:
- requirements;
- a risk-based test plan;
- test cases;
- a Playwright suite (page objects, fixtures, specs), checked against real page snapshots;
- an executive test report.

They can also work one user story at a time. A small live dashboard shows the progress.

**New here?** Start with the [tutorial](docs/tutorial/index.html). It covers installing, setting up, working with the
agents in Claude Code or Copilot, and the dashboard, with screenshots. Open the file in a browser from a clone or
download.

These agents started as those of the npm package
[`@agents-forge/aiqa`](https://www.npmjs.com/package/@agents-forge/aiqa), as plain agent and skill files: no SDK and no
package to install. They write the same `.aiqa/` files, so you can move to the full product later (see
[Same files as the npm package](#same-files-as-the-npm-package)).

## What's inside

**Agents** (`.claude/agents/`)

| Agent | Role | Writes |
|---|---|---|
| `analyst` | Explores the app with playwright-cli and saves an accessibility snapshot of every page | `.aiqa/snapshots/*.yml`, `.aiqa/requirements/requirements.md` |
| `qa-planner` | Risk-based test plan, with priorities taken from what the snapshots show | `.aiqa/test-plan/test_plan.md` |
| `qa-engineer` | Test cases, `playwright.config.ts`, page objects, fixtures and one spec per module; an axe spec and a k6 script when asked | `.aiqa/test-cases/`, `.aiqa/test-scripts/`, `playwright.config.ts` |
| `qa-reviewer` | Checks every selector against the snapshots, and the traceability from test plan to spec | `.aiqa/reports/review_report.md` |
| `qa-reporter` | Runs the suite (smoke, Chromium by default), captures failures, writes the report | `.aiqa/reports/summary_report.md` |
| `story-designer` | One story → testable acceptance criteria and manual test cases | `.aiqa/test-cases/<KEY>-<name>.md` |
| `story-explorer` | Walks those cases in the real app, saves snapshots, marks each case Verified / Updated / Possible defect… | the same file, `.aiqa/snapshots/<KEY>/` |
| `story-automator` | Playwright tests for the verified cases, tagged `@<KEY>` | `.aiqa/test-scripts/<KEY>-<name>.spec.ts` |

**Skills** (`.claude/skills/`), which you type as slash commands:

| Skill | What it does |
|---|---|
| `qa-pipeline <url>` | Runs the five full-suite agents in order |
| `qa-story <KEY>` | Runs one story: Design → Explore → Automate → Run |
| `qa-setup` | Checks and installs Playwright, playwright-cli and Chromium (it asks first) |
| `qa-dashboard` | Opens the live dashboard, with a Models page for picking each agent's model; or saves a snapshot |

## Install

### Claude Code, as a plugin
In Claude Code:
```
/plugin marketplace add rohan12patil/AIQA
/plugin install aiqa@agents-forge
```
Or from a terminal: `claude plugin marketplace add rohan12patil/AIQA`, then `claude plugin install aiqa@agents-forge`.

Installed this way, the names carry the plugin's prefix: agents are `aiqa:analyst` …, and skills are
`/aiqa:qa-pipeline` …

### For a whole team
Commit this to `.claude/settings.json` in the team's repository. Everyone who opens the project in Claude Code is
offered the plugin:
```json
{
  "extraKnownMarketplaces": {
    "agents-forge": { "source": { "source": "github", "repo": "rohan12patil/AIQA" } }
  },
  "enabledPlugins": { "aiqa@agents-forge": true }
}
```
`claude plugin marketplace add rohan12patil/AIQA --scope project` followed by
`claude plugin install aiqa@agents-forge --scope project` writes the same thing for you.

### Copy the files instead
Copy `.claude/agents/` and `.claude/skills/` into your project's `.claude/` folder, or into `~/.claude/` to have them in
every project. The names then have no prefix: `/qa-pipeline`, `analyst`. Copy all four skill folders: the dashboard
uses scripts from `qa-story`.

### GitHub Copilot
Copy `.github/agents/` and `.github/skills/` into your repository's `.github/` folder:
- The eight agents appear in Copilot's agent picker.
- The skills run as `/qa-pipeline`, `/qa-story` and so on.
- The prompts are the same as Claude Code's, with Copilot's tool names.
- Where Copilot can't start a subagent, the skills tell it to follow the agent's file itself.

These files are generated from `.claude/`, so don't edit them by hand.

### Then, once per project
Run `/aiqa:qa-setup`. It checks for and installs what the agents need, asking before each install:
- Node 20 or newer;
- `@playwright/test`;
- [playwright-cli](https://playwright.dev/agent-cli/introduction) (`npm install -g @playwright/cli@latest`);
- Chromium.

Optional: `@axe-core/playwright` for accessibility, and [k6](https://k6.io/docs/get-started/installation/) for
performance. It also offers permission rules, so you aren't asked about every `playwright-cli` command.

## Quick start
```
/aiqa:qa-setup
/aiqa:qa-pipeline https://www.saucedemo.com
/aiqa:qa-dashboard
```

## The full suite: `qa-pipeline`

```
analyst → qa-planner → qa-engineer → qa-reviewer → qa-reporter
explore    plan          automate      review        run + report
```

- **Step by step (the default):** it pauses after each step so you can read the output, and asks before going on.
  The slow **qa-reviewer** is deferred: run it later with `/aiqa:qa-pipeline qa-reviewer`.
- **`--auto`:** all five steps in one go, the reviewer included.
- **One step again:** give a step name in place of the URL, e.g. `/aiqa:qa-pipeline qa-reporter --grep @regression`.
  The target comes from the last run.

| Option | Meaning |
|---|---|
| `--grep <tags>` | What the reporter runs: `@smoke` (the default), `@regression`, `"@smoke\|@accessibility"`, or `all` for the full suite |
| `--skip a,b` | Steps to leave out |
| `--requirements <file>` | An existing requirements document for the analyst to merge with what it finds. A single `.md` file dropped in `.aiqa/requirements/` also works |
| `--headed` | Show the browser while the analyst explores |
| `--users N --minutes M` | Scale of the k6 load test (10 users, 2 minutes by default), with `@performance` |
| `--model <m>` / `--model-<role> <m>` | The model for every role, or for one role, this run (see [Models](#models)) |

Accessibility (`@accessibility`) and performance (`@performance`) tests are opt-in. They're generated only when
asked for and when `@axe-core/playwright` or k6 is installed.

**What it writes.** Everything goes under `.aiqa/`, except `playwright.config.ts` at the root. If you already have a
`playwright.config.ts`, it asks before replacing it.
```
.aiqa/
├── snapshots/*.yml            accessibility trees, one per page or state
├── requirements/requirements.md
├── test-plan/test_plan.md
├── test-cases/<module>.md
├── test-scripts/              <module>.spec.ts, pages/<module>.page.ts, fixtures.ts
├── reports/                   review_report.md, summary_report.md, test-results/, playwright-report/
└── progress.jsonl             step progress, for the dashboard
playwright.config.ts
```

## One story at a time: `qa-story`

Write the story as `.aiqa/stories/<KEY>-<name>.md`. The skill can also write this file from text you paste, or read
the story from your ALM if a Jira, Rally or Octane MCP server is connected.
```markdown
---
key: SD-1
title: Login with the demo accounts
---
# SD-1 — Login with the demo accounts

## Description
As a shopper I want to sign in so I can buy things.

## Acceptance Criteria
- A standard user reaches the products page
- A locked-out user sees "Sorry, this user has been locked out."
```
Then run `/aiqa:qa-story SD-1`. Add `--url https://www.saucedemo.com` the first time, or save the URL as `appUrl` in
`.aiqa/workspace.json`.

| Step | Who | What happens |
|---|---|---|
| Pull | code | finds the story file |
| Design | `story-designer` | testable Given/When/Then criteria, open questions, and test cases in an 11-column table |
| Explore | `story-explorer` | walks every case in the app, saves snapshots, sets each case's status |
| Automate | `story-automator` | Playwright tests for Verified / Updated / New cases; a Possible defect becomes `test.fixme` |
| Run | code | runs the story's tests, writes **Last Result**, **Evidence** (screenshots) and **Run History** into the test cases |

- **Pauses for review:** it stops after Design and after Explore, so you can edit the cases first. `--auto` skips the pauses.
- **The defect rule:** when the app contradicts the story, Explore never changes the expected result to match the
  app. The case is marked **Possible defect** instead.
- **Results come from code,** so a pass or fail is never made up.
- **Other options:** `--step design|explore|automate|run` runs one step, and `--force` redoes a step that's already done.

## The dashboard: `qa-dashboard`

![The AIQA dashboard during a full-suite run](examples/saucedemo/screenshots/dashboard-suite.png)

- `/aiqa:qa-dashboard` starts a local page and gives you its link. It follows a running pipeline or story every two
  seconds.
- **Views:**
  - Full suite: the five steps with their outputs;
  - Stories: each story's steps, test cases, notes and runs;
  - Results: the latest Playwright runs, failures, and links to the HTML report;
  - Models: the model each agent starts with (see [Models](#models)).
- **Looks:** AIQA's Slate and Industrial themes, in light and dark. It works at phone width.
- **Local and read-only:** it serves on 127.0.0.1 behind a random link and only reads `.aiqa/`. The one exception is
  the Models page, which saves `.aiqa/ai.json`.
- `--static` saves a self-contained `.aiqa/reports/dashboard.html` you can attach or share.

## Models
Each role's agent can run on its own Claude model.
- **On the dashboard:** open **Models** and pick Session model, Sonnet, Opus, Haiku or Fable for Default and each of
  the five roles. Then press Save.
- **For one run:** `/aiqa:qa-pipeline https://my-app.com --model-qa-planner opus`, or `--model haiku` for every
  role. `qa-story` takes the same options.

`qa-pipeline` and `qa-story` start each agent with its role's model, so a change applies from the next step that
starts. The story steps use the full-suite roles: Design = QA Planner, Explore = Analyst, Automate = QA Engineer.

The order of precedence:
1. an option on the command;
2. the role's own pick on the Models page;
3. the Default pick;
4. the model of your Claude Code session (the agents' own `model: inherit`).

The picks are saved in `.aiqa/ai.json`, the same file and format that the npm package's Connect → AI uses, so they
carry over in both directions. GitHub Copilot uses its own model picker, so the picks don't apply there.

![The Models page](examples/saucedemo/screenshots/dashboard-models.png)

## Updating
```
claude plugin marketplace update agents-forge
claude plugin update aiqa@agents-forge
```
Restart Claude Code after updating.

## Example
[examples/saucedemo](examples/saucedemo) walks through a real run of the agents on saucedemo.com: what each step did,
how long it took, and screenshots of the dashboard. The run's output files aren't committed; this repository holds
only the agents and skills.

## Same files as the npm package
The agents write exactly the files `@agents-forge/aiqa` reads, in the same `.aiqa/` layout. That includes the
test-case table, the story hash and the results columns. On the same project you can later run:
- `npx @agents-forge/aiqa ui`, for the full workspace dashboard;
- `aiqa regression` and `aiqa alm push`, for regression runs and sending results to Jira;
- the approval-before-commit flow.

## Safety
- **No git writes:** every agent prompt forbids git commands that change the repository. A person reviews and
  commits the work. Unlike the npm package, nothing checks this in code: review what the agents changed before you
  commit.
- **Story text is data:** it's handed to the agents fenced as untrusted data, and instructions found in it are
  recorded as a finding, never followed.
- **Saved logins:** `.aiqa/auth-state.json` holds a signed-in browser session. `qa-setup` offers to git-ignore it.

## Working on this repository
- `.claude/` is the source. After changing an agent or a skill, run `npm run build`. It checks every agent's
  frontmatter, updates the plugin's agent list and regenerates the Copilot copies in `.github/`.
- `npm test` runs the tests. CI runs both and fails when the generated files are out of date.
- The prompts started as a port of `@agents-forge/aiqa` 2.5. This repository is kept separate from it: change the
  agents and skills here, list the change in `CHANGELOG.md`, and bump the version in `.claude-plugin/plugin.json`
  and `marketplace.json` for each release.

## License
MIT. The bundled fonts (IBM Plex, Barlow) are under the SIL Open Font License; see the files next to them.
