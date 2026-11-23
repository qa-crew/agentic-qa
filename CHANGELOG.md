# Changelog

Every change to Agentic QA is listed here.

## Unreleased

### Added
- **Share and reuse snapshots:** a teammate's committed snapshots and requirements no longer need capturing again.
  The start form offers **Reuse** (start at the QA Planner, no exploring), **Refresh** (the Analyst's new refresh mode
  recaptures only what changed or is new and adds "Changes since" to requirements.md; `/qa-pipeline --refresh` in the
  chat) or **Explore from scratch**, when snapshots exist. The Full suite page says whether the snapshots are committed
  (read-only git), with the commands when they aren't. `qa-setup` now also offers to ignore `.agentic-qa/logs/` and
  `.playwright-cli/`, and warns when `.gitignore` hides all of `.agentic-qa/` from the team.
- **Your AI, checked before every run:** Settings → AI shows whether Claude Code and GitHub Copilot are installed and
  signed in, and the plan ("Claude Pro", "Copilot Free · 200 chat requests left"), from `claude auth status`, Copilot's
  sign-in and `gh api copilot_internal/user`. Nothing is sent to either AI to check, and no email, login or
  organization reaches the page. A run refuses to start (with the fix) when the AI it runs on isn't ready. On Windows,
  Copilot needs PowerShell 7 to run the agents' shell commands; the check says so.
- **Run on Claude or Copilot:** pick which AI runs the agents in Settings → AI, with its own model per role (Claude's
  aliases, or Copilot model ids such as gpt-4.1 or claude-sonnet-4.5). On Copilot each step runs as
  `copilot -p … --agent <step>` with the agents in `.github/agents/`, and its activity shows in the run panel.
- **Models for this run:** the start form and a story's next step have a "Models for this run" section, pre-filled from
  Settings → AI. A run keeps its picks and its AI when you continue it; the run panel shows each step's model.
- **Settings in four tabs** (as in AIQA's Connect): **AI** (the Models page moved here; `#models` still works),
  **Project** (the app's address, saved in `.agentic-qa/workspace.json`, which the qa-story skill already reads; the
  start form and a story's next step start from it), **Connection** (where stories come from) and **Appearance**.
- **Open questions tick off:** a story's Open questions tab lists them with tick boxes, kept as `answered: <id>, …` in
  the test-case file's front matter. The tab, the status line and the review bar count only the open ones.
- **A ⋯ menu on each story:** Redo from the start (`/qa-story <KEY> --force`, after a confirmation), and open the test
  cases or the story file in your editor.
- **A manual testing guide** (as in AIQA): **Test by hand** on a story's test cases, or **Record a manual result** on a
  failure, steps through the cases one at a time. Pick Passed, Failed or Blocked, write a note, and paste (Ctrl+V), drop
  or choose a screenshot. Save writes Last Result ("❌ Failed (manual) · <date> · <note>") and, with a screenshot,
  Evidence (a PNG or JPEG of at most 5 MB, checked by its first bytes, saved in
  `.agentic-qa/evidence/<KEY>/manual-<stamp>/`). A save is refused if the case changed since the card opened, or while
  one of the story's steps is running. Manual results don't add a Run History row; that table counts automated runs.
- **A Runs page** (as in AIQA): every run of the full suite and of each story, newest first, with its steps, when it
  started, how long its steps took (not the time it waited for your review), the tokens it used and how it ended (the
  failed step, the tests' totals, or done). Filters: All, Failed, AI steps. A row opens its suite or story.
- **AIQA's shell in the dashboard.**
  - **A Run activity panel** on the right of every page (it folds to a strip). It shows what's running or ran last:
    the step and its time, counts (files written, pages captured, tokens), Continue or Stop, and the activity as it
    happens, tagged WRITE, EDIT, AGENT, SNAP, RUN, NOTE, WARN, DONE or FAIL. Each session's activity is kept in
    `.agentic-qa/logs/<run>/<step>.events.jsonl`, and its token use in a `usage` line in `progress.jsonl`.
  - **Header pills** for what's running, the stories waiting for you and the last test run, and the app under test
    under the project name.
  - **A jump box (Ctrl/⌘K)** to any story, test case or file.
  - **On a story:** the story list beside it, with All / Your turn / Failing filters and a manual · automated bar per
    story, and a status line ("1 of 1 ACs covered · 3 cases … · 1 possible defect · 151k tokens to date").
  - **Tokens on each step card;** screenshots open in a lightbox (← → to step through); eyebrow labels, an accent mark
    under page titles, and a segmented control for the tests to run.
- **Start and continue runs from the dashboard.** The Now page opens on a form for the app's address, the tests to
  run, step by step or all five steps, and showing the browser. The dashboard then runs each full-suite step itself as
  a headless Claude Code session (`claude -p --agent <step>`, `acceptEdits`, only playwright-cli, Playwright, k6 and
  mkdir allowed), checks its output on disk like the qa-pipeline skill, and pauses with a **Continue** button. Every
  finished step has **Run again**, the deferred QA Reviewer has **Run it now**, a running step shows its live log
  (`.agentic-qa/logs/<run>/<step>.log`) and a **Stop** button, and a story's page has a button for its next step.
- **Edit test cases on the story page,** as in AIQA: an **Edit** form for each case (criterion, title, preconditions,
  steps one per line and numbered for you, expected result, tags, status), **+ Add** with the next free ID of the
  type, and **Delete**, which lists the ID under `retired` so Design never brings it back. A save is refused when the
  row changed in the file since the form opened, or while one of the story's steps is running. **E** edits the
  selected case.
- **Edit any document in the reader:** requirements, the test plan, reports, specs, page objects, snapshots and
  `playwright.config.ts` get **Edit** (a text editor with Ctrl+S; the save is refused if an agent wrote the file
  meanwhile) and **Open in editor** (VS Code, or `$AGENTIC_QA_EDITOR`, else the computer's default app).
- **Progress as a progress bar:** "3 of 5 steps done · 60%", a bar in five equal parts (done, running, failed,
  skipped, next), and a row of step cards with ✓ or the step's number; the current step is highlighted. The story
  page has the same bar over its five steps.
- **Copilot listed every agent twice** in this repository, because VS Code also reads `.claude/agents/`.
  `.vscode/settings.json` now limits it to `.github/agents/`, and the README says how to do the same.
- **The Now page's title** is "Now" with the date, like the other pages' titles, and the sentence on what's
  happening is the lead under it, instead of a 42px headline.
- **The reader scrolls on its own.** On the Full suite page, the file list and the open file are separate scroll
  views the height of the window, so a long list of snapshots no longer stretches the page. The list has a filter and
  groups that fold; a story's test cases scroll the same way.
- **Four dashboard themes,** each in light and dark: **Geist** (the new default), **Carbon**, **Industrial** and
  **Corporate**. Carbon also gives every status a shape: Verified a circle, Possible defect a diamond, Blocked a
  triangle, New and Draft a square, Updated a hexagon. The Geist, Geist Mono, Source Sans 3, Source Serif 4 and Source
  Code Pro fonts are bundled, so the dashboard still works offline.
- **A Settings page** in the dashboard: pick a theme and mode (light, dark or match your computer), see it on the
  page, then save it for this browser only or as the **project default** in `.agentic-qa/settings.json`
  (`{ "appearance": { "theme", "mode" } }`). Commit the file to share the look with your team. Your
  browser's choice wins over the project default, which wins over the built-in look (Geist, matching your
  computer). The appearance menu's choices are for this browser and link to Settings.
- **A Now page,** the dashboard's new start page: one sentence on what's happening; the suite's five steps as a track
  whose bars follow how long each step took; **Waiting for you**, with each story or step that needs your review and
  the command to continue, with a Copy button; the stories with a five-part progress track; the last test run; and
  the activity from `progress.jsonl`.
- **Design tokens** in `design/tokens/`: each theme and mode as a DTCG file that Figma can import as variables,
  generated from the dashboard's `theme.css` by `npm run build` and checked by `npm run check`. `design/README.md` has
  the colour rules and type.

### Changed
- **Story review is one case at a time.** The test cases are grouped by acceptance criterion in a list, with filters
  by status; the selected case shows its criterion, steps, expected result, tags and last result (with its
  screenshot). The up and down arrow keys move between cases, and the link keeps the case (`#story/SD-3/cases/<id>`).
  A **Possible defect** shows what the story says next to what the app does, taken from the Exploration Notes line
  that names the case. The your-turn bar has the command to continue and a Copy button.
- **Results show failures first:** each with its full error, the screenshot Playwright took (when it's inside
  `.agentic-qa/`), and the manual test case with the same ID, so you can check it by hand. Then the flaky tests, every
  spec with bars for its results and time, and each story's recent runs.
- **Full suite has a reader:** pick a document, test-case file, spec, page object or snapshot to read it beside the
  list.
- **The tutorial uses Geist,** the dashboard's default look, with the Geist fonts bundled under `docs/tutorial/fonts/`,
  and new screenshots of an example project.
- **The Slate theme is replaced by Geist.** A browser that had Slate saved shows Geist.
- **One meaning per colour** in every theme: the accent (blue, or yellow in Industrial) only marks "your turn"
  (Waiting for you, Your turn: review); green, orange and red are only for status; Running, Next, Updated and New
  are neutral; flaky and warnings are orange. The selected tab and the running step are drawn in ink.
- The dashboard now writes two files, each from its own page: `.agentic-qa/ai.json` (Models) and
  `.agentic-qa/settings.json` (Settings). Both only accept same-origin JSON with known values.

## 1.0.0 — 2026-11-13

The first release of Agentic QA, the open-source QA agents. The earlier proof of concept (Playwright's planner,
generator and healer agents, the saucedemo tests and the deck) is removed; it stays in git history.

### Added
- **Eight agents for Claude Code** (`.claude/agents/`):
  - the full suite: `analyst`, `qa-planner`, `qa-engineer`, `qa-reviewer`, `qa-reporter`;
  - the story workflow: `story-designer`, `story-explorer`, `story-automator`.
- **Four skills:**
  - `qa-pipeline`: step by step or `--auto`, with the reviewer deferred. A step name runs just that step of the last
    run. The skill saves the reporter's report, because Claude Code doesn't let a subagent write `summary_report.md`;
  - `qa-story`: Design → Explore → Automate → Run, with code for the story hash, the story Playwright config and
    writing results into the test cases;
  - `qa-setup`;
  - `qa-dashboard`: live, or a `--static` snapshot.

  You can type them as commands, or ask in plain words: Claude may start `qa-pipeline`, `qa-story` and
  `qa-dashboard` itself. `qa-setup` is only ever typed, because it installs software. Each skill pre-approves its own
  scripts, written exactly as it runs them, so they don't ask for permission on every call.
- **A model for each agent:**
  - the dashboard's Models page saves the picks to `.agentic-qa/ai.json`;
  - `qa-pipeline` and `qa-story` start each agent with its role's model;
  - `--model` and `--model-<role>` set them for one run.
- **An example:** `examples/saucedemo`, a walkthrough of a real run with screenshots.
- **A tutorial:** `docs/tutorial/index.html`, one page covering install, setup, working with Claude Code or Copilot,
  both workflows, the dashboard (with screenshots of every view) and models. It's online at
  https://qa-crew.github.io/agentic-qa/tutorial/, served by GitHub Pages from `docs/`.
- **A Claude Code plugin and marketplace:** `/plugin marketplace add qa-crew/agentic-qa`, then
  `/plugin install agentic-qa@qa-crew`. The plugin is `agentic-qa`, so the commands are
  `/agentic-qa:qa-pipeline` and so on. The repository lives in the `qa-crew` organization on GitHub.
- **GitHub Copilot copies** in `.github/agents/` and `.github/skills/`, generated by `scripts/build.mjs`.
- **Tests and CI.** The tests cover the story hash, file names, step state, the results writer, the story config,
  the dashboard and the docs' install commands.

### Found in the first full run
From the run on saucedemo (see `examples/saucedemo`):
- **Tests start signed out.** The qa-engineer's `playwright.config.ts` doesn't load `.agentic-qa/auth-state.json`
  for every test. Tests that need a signed-in user use a sign-in fixture.
- **Listing tests keeps the latest results.** The generated config uses the plain list reporter for `--list`, so
  a listing doesn't overwrite the JSON, JUnit and HTML reports. The qa-reporter and story-automator prompts give
  the safe command, `npx playwright test --list --reporter=list`.
- **Story runs use the suite's test-id attribute.** When the project's `playwright.config.ts` sets
  `testIdAttribute` (e.g. `data-test`), the story config sets it too, so the shared page objects work in story runs.
