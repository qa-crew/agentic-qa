---
name: qa-dashboard
description: Open Agentic QA's local dashboard (Slate or Industrial theme, light or dark). It shows the full-suite steps as they run, the requirements, test plan and test cases, each story's steps and test cases, snapshots and test results, and a Models page for picking the model each agent runs on. Use --static to save a snapshot file instead. Use it when the user asks to see the QA progress, documents or results, to change the model for a role, or for a dashboard file to share.
argument-hint: "[--static [<out.html>]] [--port <n>]"
allowed-tools: Bash(node ".github/skills/qa-dashboard/dashboard/server.mjs") Bash(node ".github/skills/qa-dashboard/dashboard/server.mjs" *)
---
<!-- Generated from .claude/skills/qa-dashboard/SKILL.md by scripts/build.mjs. Edit that file, then run: npm run build -->

# Agentic QA dashboard

Arguments: $ARGUMENTS

The dashboard reads `.agentic-qa/` (and the root `playwright.config.ts`). The only thing it ever writes is
`.agentic-qa/ai.json`, from its Models page. Continuing, re-running or stopping a step happens in the chat.

Run each `node ".github/skills/qa-dashboard/…"` command on its own, exactly as written here, not joined to other commands with `&&` or `;`. Only then does it run without a permission prompt.

## Live (the default)
Start the server from the project root, **in the background** (it keeps serving until it's stopped):
```bash
node ".github/skills/qa-dashboard/dashboard/server.mjs" --open
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
  - **Models**: the model each role's agent starts with, saved in `.agentic-qa/ai.json` and used by the qa-pipeline and
    qa-story skills from their next step;
- the Appearance menu switches Slate / Industrial and light / dark;
- to stop it, stop the background command (or press Ctrl+C where it runs).

## Snapshot (`--static`)
```bash
node ".github/skills/qa-dashboard/dashboard/server.mjs" --static
```
This writes `.agentic-qa/reports/dashboard.html`, or the path given after `--static`. It's one self-contained file to
attach or share. In it the Models page is read-only. Its links to screenshots and the Playwright report work while
the file stays in `.agentic-qa/reports/`. It uses system fonts instead of the bundled ones.
