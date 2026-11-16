---
name: qa-dashboard
description: Open Agentic QA's local dashboard (Geist, Carbon, Industrial or Corporate theme, light or dark). It shows what's running and what's waiting for the user's review, the full-suite steps as they run, the requirements, test plan and test cases, each story's steps and test cases, snapshots and test results, a Models page for picking the model each agent runs on, and a Settings page for saving the look for the browser or as the project default. Use --static to save a snapshot file instead. Use it when the user asks to see the QA progress, documents or results, to change the model for a role, or for a dashboard file to share.
argument-hint: "[--static [<out.html>]] [--port <n>]"
allowed-tools: Bash(node "${CLAUDE_SKILL_DIR}/dashboard/server.mjs") Bash(node "${CLAUDE_SKILL_DIR}/dashboard/server.mjs" *)
---

# Agentic QA dashboard

Arguments: $ARGUMENTS

The dashboard reads `.agentic-qa/` (and the root `playwright.config.ts`). It writes only two files:
`.agentic-qa/ai.json` from its Models page, and `.agentic-qa/settings.json` from its Settings page. Continuing, re-running or stopping a step happens in the chat.

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
- the six views:
  - **Now** (the start page): what's running, what's waiting for their review (with the command to continue), the
    stories, the last test run and the activity;
  - **Full suite**: the five steps, and a reader for the documents, test cases, specs, page objects and snapshots;
  - **Stories**: each story's steps and its test cases, one at a time, grouped by acceptance criterion; a Possible
    defect shows what the story says next to what the app does;
  - **Results**: failures first, with the error, the screenshot and the matching manual test case; then flaky tests,
    every spec and each story's recent runs;
  - **Models**: the model each role's agent starts with, saved in `.agentic-qa/ai.json` and used by the qa-pipeline and
    qa-story skills from their next step;
  - **Settings**: the theme (Geist, Carbon, Industrial or Corporate), light / dark and density, saved for this browser
    or as the project default in `.agentic-qa/settings.json`;
- the Appearance menu switches the theme and light / dark for this browser;
- to stop it, stop the background command (or press Ctrl+C where it runs).

## Snapshot (`--static`)
```bash
node "${CLAUDE_SKILL_DIR}/dashboard/server.mjs" --static
```
This writes `.agentic-qa/reports/dashboard.html`, or the path given after `--static`. It's one self-contained file to
attach or share. In it the Models page is read-only, and Settings can only save for the browser. Its links to screenshots and the Playwright report work while
the file stays in `.agentic-qa/reports/`. It uses system fonts instead of the bundled ones.
