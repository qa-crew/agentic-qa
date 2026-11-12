// A throwaway project with AIQA files in it: a full-suite run in progress and one story.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const STORY_SD1 = `---
key: SD-1
title: "Login: authenticate demo users"
---
# SD-1 — Login: authenticate demo users

## Description

As a shopper I want to log in.

## Acceptance Criteria

- Valid users reach the inventory page
- Locked users see an error
  - with the text "locked out"
1. Wrong password shows an error
`;

/** storyHash of STORY_SD1, computed by @agents-forge/aiqa 2.5's own storyHash(). */
export const STORY_SD1_HASH = "bb6a15268210";

export const TEST_CASES_SD1 = `---
story: SD-1
storyHash: ${STORY_SD1_HASH}
title: Login
---
# SD-1 — Login — Test Cases

## Testable Acceptance Criteria
- **AC1** — Given a valid user, when they log in, then the inventory shows

## Open Questions
- None

## Test Cases
| ID | AC | Title | Preconditions | Steps | Expected | Tags | Status | Last Result | Evidence | ALM |
|---|---|---|---|---|---|---|---|---|---|---|
| TC-SD1-S-001 | AC1 | Valid login | — | 1. Open<br>2. Log in | Inventory shows | @smoke @p0 @SD-1 | Verified | — | — | — |
| TC-SD1-N-001 | AC2 | Locked \\| user | — | 1. Log in | Error | @negative @p1 @SD-1 | Possible defect | — | — | — |
| TC-SD1-E-001 | AC1 | Edge | — | 1. x | y | @edge @p2 @SD-1 | Blocked | — | — | — |

## Exploration Notes
Explored on 2026-11-11. <script>alert(1)</script>
`;

export function playwrightReport(shot) {
  return {
    stats: { duration: 4321, startTime: "2026-11-11T10:00:00.000Z" },
    suites: [{
      title: "login.spec.ts", file: "login.spec.ts", specs: [], suites: [{
        title: "Login — Smoke", specs: [
          { title: "TC-SD1-S-001 — Valid login", tests: [{ status: "expected", results: [{ duration: 1234, status: "passed", attachments: shot ? [{ path: shot, contentType: "image/png" }] : [] }] }] },
          { title: "TC-SD1-N-001 — Locked", tests: [{ status: "unexpected", results: [{ duration: 50, status: "failed", error: { message: "\u001b[31mExpected: locked\u001b[39m\nmore" } }] }] },
          { title: "no id here", tests: [{ status: "expected", results: [] }] },
        ],
      }],
    }],
  };
}

export function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiqa-test-"));
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const t = (s) => new Date(Date.parse("2026-11-11T10:00:00Z") + s * 1000).toISOString();
  w(".aiqa/progress.jsonl", [
    { ts: t(0), kind: "suite", step: "pipeline", event: "start", run: "R1", target: "https://www.saucedemo.com", filter: "none" },
    { ts: t(1), kind: "suite", step: "analyst", event: "start", run: "R1" },
    { ts: t(91), kind: "suite", step: "analyst", event: "done", run: "R1" },
    { ts: t(92), kind: "suite", step: "qa-planner", event: "start", run: "R1" },
    { ts: t(150), kind: "suite", step: "qa-planner", event: "done", run: "R1" },
    { ts: t(151), kind: "suite", step: "qa-engineer", event: "start", run: "R1" },
  ].map((e) => JSON.stringify(e)).join("\n") + "\nnot json\n");
  w(".aiqa/requirements/requirements.md", "# Requirements\n\n## 1. Executive Summary\nA shop.\n");
  w(".aiqa/test-plan/test_plan.md", "# Test plan\n");
  w(".aiqa/snapshots/home.yml", "- button \"Login\"\n");
  w(".aiqa/test-cases/login.md", "# Login — Test Cases\n\n| ID | Title |\n|---|---|\n| TC-LOGIN-S-001 | a |\n| TC-LOGIN-S-002 | b |\n");
  w(".aiqa/test-scripts/login.spec.ts", "import { test } from './fixtures';\n");
  w(".aiqa/test-scripts/pages/login.page.ts", "export class LoginPage {}\n");
  w(".aiqa/reports/test-results/results.json", JSON.stringify(playwrightReport()));
  w(".aiqa/stories/SD-1-login.md", STORY_SD1);
  w(".aiqa/test-cases/SD-1-login.md", TEST_CASES_SD1);
  w(".aiqa/test-scripts/SD-1-login.spec.ts", "test('TC-SD1-S-001 — Valid login', { tag: ['@SD-1'] }, async () => {});\n");
  w(".aiqa/snapshots/SD-1/login.yml", "- textbox \"Username\"\n");
  w("secret.txt", "do not serve");
  return dir;
}
