---
name: qa-dashboard
description: Open Agentic QA's local dashboard (Geist, Carbon, Industrial or Corporate theme, light or dark). It shows what's running and what's waiting for the user's review, the full-suite steps as they run, the requirements, test plan and test cases, each story's steps and test cases, snapshots and test results, a Models page for picking the model each agent runs on, and a Settings page for saving the look for the browser or as the project default. Use --static to save a snapshot file instead. Use it when the user asks to see the QA progress, documents or results, to change the model for a role, or for a dashboard file to share.
argument-hint: "[--static [<out.html>]] [--port <n>]"
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/dashboard/server.mjs") Bash(node "${CLAUDE_SKILL_DIR}/dashboard/server.mjs" *)
---

# Agentic QA dashboard

Arguments: $ARGUMENTS

The dashboard reads `.agentic-qa/` (and the root `playwright.config.ts`). It's also a place to **start and continue
runs**: give it the app's address and it runs the full suite's steps itself, one at a time, each as a headless Claude
Code session (`claude -p --agent <step>`) in the project root, and records them in `.agentic-qa/progress.jsonl` and
`.agentic-qa/logs/`. Besides that it writes `.agentic-qa/ai.json`, `.agentic-qa/workspace.json` and `.agentic-qa/settings.json` from its Settings tabs,
from its Settings page.

Run each `node "${CLAUDE_SKILL_DIR}/…"` command on its own, exactly as written here, not joined to other commands with `&&` or `;`. Only then does it run without a permission prompt.

## Live (the default)
Start the server from the project root, **in the background** (it keeps serving until it's stopped):
```bash
node "${CLAUDE_SKILL_DIR}/dashboard/server.mjs" --open
```
Add `--port <n>` when the user asked for a fixed port. The server prints a link like
`http://127.0.0.1:52341/3f9c…/`. Give the user that link. `--open` also opens it in their browser. The page polls
every 2 seconds, so it follows a pipeline or story run as it happens.

Tell the user:
- the link only works on this machine (the server listens on 127.0.0.1 and the link carries a random token);
- **starting a run from the page:** the Now page has a form for the app's address, whether to reuse, refresh or
  re-explore the snapshots already in the project (when there are some), the tests to run, step by step or
  all five steps, and showing the browser. Step by step, the run pauses after each step with a **Continue** button
  (the QA Reviewer is deferred, with a **Run it now** button); every finished step has **Run again**, and a running
  step shows its live log and a **Stop** button. A story's page has a button for its next step (it runs
  `/qa-story <KEY>` up to the next review). Each run first checks the AI it runs on (Claude Code or
  GitHub Copilot, picked in Settings → AI) is signed in, and the start form can set each step's model for that run. This
  needs the `claude` or `copilot` CLI on PATH; on Claude the agents run with
  `acceptEdits` and may only run playwright-cli, Playwright, k6 and mkdir. Stopping the server stops a step it started;
- **AIQA's shell:** a Run activity panel on the right of every page (live activity, counts, tokens, Continue / Stop),
  header pills for what's running and waiting, and a jump box (Ctrl/⌘K) to any story, test case or file;
- the seven views:
  - **Now** (the start page): the form to start a run, what's running, what's waiting for their review (with the
    button to continue), the stories, the last test run and the activity;
  - **Full suite**: whether the snapshots are committed for the team (with the commands when they aren't), a progress bar ("3 of 5 steps done") over the five steps and their buttons, and a reader for the documents, test cases, specs, page objects
    and snapshots. The reader has its own scroll view: the file list (with a filter) and the open file scroll
    separately. Each file has **Edit** (a text editor; the save is refused if an agent wrote the file meanwhile) and
    **Open in editor** (VS Code, or `$AGENTIC_QA_EDITOR`);
  - **Stories**: each story's steps and its test cases, one at a time, grouped by acceptance criterion, with **Edit**,
    **+ Add** and **Delete** for each case, and **Test by hand**: a guide that records each case's result (Passed,
    Failed or Blocked), a note and a screenshot; a Possible
    defect shows what the story says next to what the app does;
  - **Runs**: every run of the suite and of each story, with its steps, time, tokens and result;
  - **Results**: failures first, with the error, the screenshot and the matching manual test case; then flaky tests,
    every spec and each story's recent runs;
  - **Settings**, in four tabs: **AI**, whether Claude Code and GitHub Copilot are signed in (and their plans),
    which one runs the agents, and each role's model, saved in `.agentic-qa/ai.json` and used by the qa-pipeline and
    qa-story skills from their next step; **Project**, the app's address, saved in
    `.agentic-qa/workspace.json`; **Connection**, where stories come from; **Appearance**, the theme (Geist, Carbon,
    Industrial or Corporate) and light / dark, saved for this browser or as the project default in
    `.agentic-qa/settings.json`;
  - **on a story:** its open questions tick off as they're answered, and its ⋯ menu redoes it from the start;
- the Appearance menu switches the theme and light / dark for this browser;
- to stop it, stop the background command (or press Ctrl+C where it runs).

## Snapshot (`--static`)
```bash
node "${CLAUDE_SKILL_DIR}/dashboard/server.mjs" --static
```
This writes `.agentic-qa/reports/dashboard.html`, or the path given after `--static`. It's one self-contained file to
attach or share. In it Settings → AI and Project are read-only, and Settings can only save for the browser. Its links to screenshots and the Playwright report work while
the file stays in `.agentic-qa/reports/`. It uses system fonts instead of the bundled ones.
