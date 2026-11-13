---
name: qa-setup
description: Check and install what the Agentic QA agents need in this project (Node, @playwright/test, playwright-cli and its skill, Chromium, plus the optional @axe-core/playwright and k6), and suggest permission rules and .gitignore lines. It asks before installing anything.
disable-model-invocation: true
allowed-tools: Bash(node --version) Bash(npm ls *) Bash(playwright-cli --version) Bash(npx --no-install playwright --version) Bash(k6 version)
---

# Agentic QA setup

Check each item in order and report a short table: item, status (✅ ready, ⚠️ optional and missing, ❌ missing),
and the fix. **Ask before installing anything**, one question that lists everything missing (the user can untick
items). Never install silently, and never change the user's settings or .gitignore without a yes.

| # | Item | Check | Install (after a yes) |
|---|---|---|---|
| 1 | Node.js 20 or newer | `node --version` | Tell the user to install it from nodejs.org (can't be done from here) |
| 2 | A `package.json` | the file exists | `npm init -y` |
| 3 | @playwright/test | `npm ls @playwright/test --depth=0` | `npm install --save-dev @playwright/test` |
| 4 | playwright-cli | `playwright-cli --version` | `npm install -g @playwright/cli@latest` |
| 5 | Chromium for Playwright | `npx --no-install playwright --version`, then whether a run finds the browser | `npx playwright install chromium` |
| 6 | playwright-cli skill (optional, helps agents use the CLI) | a `playwright-cli` skill folder in `.claude/skills/` | `playwright-cli install --skills` |
| 7 | @axe-core/playwright (optional, for `@accessibility`) | `npm ls @axe-core/playwright --depth=0` | `npm install --save-dev @axe-core/playwright` |
| 8 | k6 (optional, for `@performance`) | `k6 version` | Point to https://k6.io/docs/get-started/installation/ (it's not an npm package) |

## Permissions (optional)
The agents run `playwright-cli` and `npx playwright` many times. To avoid a prompt for each one, offer to add
these rules to `.claude/settings.json` (merge them with what's there and keep the user's other settings):
```json
{
  "permissions": {
    "allow": ["Bash(playwright-cli:*)", "Bash(npx playwright:*)", "Bash(mkdir -p .aiqa/*)"]
  }
}
```

## .gitignore (optional)
Agentic QA's outputs under `.aiqa/` (requirements, test plan, test cases, test scripts, snapshots) are meant to be
committed. Offer to add these lines to `.gitignore` for the files that shouldn't be:
```
.aiqa/auth-state.json
.aiqa/reports/
.aiqa/evidence/
.aiqa/progress.jsonl
```
`auth-state.json` holds a signed-in browser session, so it should never be committed.

## Finish
Say what's ready and what to run next: the qa-pipeline skill with a URL for a full suite, or the qa-story skill with
a story key.
