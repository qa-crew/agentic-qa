---
name: qa-dashboard
description: Open AIQA's local dashboard in AIQA's look (Slate/Industrial, light/dark). It shows the full-suite steps as they run, the requirements, test plan and test cases, each story's steps and test cases, snapshots and test results, and a Models page for picking the model each agent runs on. Use --static to save a snapshot file instead.
argument-hint: "[--static [<out.html>]] [--port <n>]"
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/dashboard/server.mjs) Bash(node ${CLAUDE_SKILL_DIR}/dashboard/server.mjs *)
---

# AIQA dashboard

Arguments: $ARGUMENTS

The dashboard reads `.aiqa/` (and the root `playwright.config.ts`). The only thing it ever writes is
`.aiqa/ai.json`, from its Models page. Continuing, re-running or stopping a step happens in the chat.

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
- the four views:
  - **Full suite**: the five steps;
  - **Stories**: each story's steps and test cases;
  - **Results**: the latest runs;
  - **Models**: the model each role's agent starts with, saved in `.aiqa/ai.json` and used by the qa-pipeline and
    qa-story skills from their next step;
- the Appearance menu switches Slate / Industrial and light / dark;
- to stop it, stop the background command (or press Ctrl+C where it runs).

## Snapshot (`--static`)
```bash
node "${CLAUDE_SKILL_DIR}/dashboard/server.mjs" --static
```
This writes `.aiqa/reports/dashboard.html`, or the path given after `--static`. It's one self-contained file to
attach or share. In it the Models page is read-only. Its links to screenshots and the Playwright report work while
the file stays in `.aiqa/reports/`. It uses system fonts instead of the bundled ones.
