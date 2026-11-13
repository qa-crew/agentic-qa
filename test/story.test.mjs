import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  aiqaPaths, applyResults, parseStoryFile, parseTestCaseFile, statusCounts, stepState, storyHash, storySlug, updateTestCaseRows,
} from "../.claude/skills/qa-story/scripts/aiqa-files.mjs";
import { makeProject, playwrightReport, STORY_SD1, STORY_SD1_HASH, TEST_CASES_SD1 } from "./helpers/fixture.mjs";

const STORY_CLI = fileURLToPath(new URL("../.claude/skills/qa-story/scripts/story.mjs", import.meta.url));

test("storyHash matches @agents-forge/aiqa 2.5", () => {
  // Expected values come from the npm package's own storyHash() on the same text.
  assert.equal(storyHash(parseStoryFile(STORY_SD1, "SD-1-login.md")), STORY_SD1_HASH);
  const us = "# US1234 — Checkout with a promo code\n\nThe user can apply a code.\n\n**Acceptance Criteria:**\n- Given a valid code, when applied, then the total drops\n- Given an expired code, then an error shows\n\nMore text.\n";
  const item = parseStoryFile(us, "US1234-checkout.md");
  assert.equal(item.key, "US1234");
  assert.deepEqual(item.acceptanceCriteria, ["Given a valid code, when applied, then the total drops", "Given an expired code, then an error shows"]);
  assert.equal(storyHash(item), "98a52a78db61");
});

test("story file parsing keeps nested criteria lines", () => {
  const item = parseStoryFile(STORY_SD1, "SD-1-login.md");
  assert.equal(item.title, "Login: authenticate demo users");
  assert.deepEqual(item.acceptanceCriteria, ["Valid users reach the inventory page", 'Locked users see an error\n- with the text "locked out"', "Wrong password shows an error"]);
});

test("storySlug names files like the npm package", () => {
  assert.equal(storySlug("Login: authenticate demo users and redirect"), "login");
  assert.equal(storySlug("Checkout with a promo code"), "checkout-promo-code");
  assert.equal(storySlug("As a shopper, I want to filter products by price"), "filter-products-price");
  assert.equal(storySlug("Ünïcödé — résumé upload"), "unicode");
});

test("updateTestCaseRows changes only the matched cells", () => {
  const { text, updated } = updateTestCaseRows(TEST_CASES_SD1, { "TC-SD1-S-001": { "Last Result": "✅ Passed" } });
  assert.deepEqual(updated, ["TC-SD1-S-001"]);
  assert.match(text, /\| TC-SD1-S-001 \| AC1 \| Valid login \| — \| 1\. Open<br>2\. Log in \| Inventory shows \| @smoke @p0 @SD-1 \| Verified \| ✅ Passed \|/);
  assert.ok(text.includes("| TC-SD1-N-001 | AC2 | Locked \\| user |"), "escaped pipe kept");
  assert.equal(statusCounts(parseTestCaseFile(text).table)["Possible defect"], 1);
});

test("applyResults writes Last Result, Evidence and Run History", () => {
  const dir = makeProject();
  const sp = aiqaPaths(dir);
  const shot = path.join(dir, "shot.png");
  fs.writeFileSync(shot, "png");
  const results = path.join(dir, "results.json");
  fs.writeFileSync(results, JSON.stringify(playwrightReport(shot)));
  const tcFile = path.join(sp.testCasesDir, "SD-1-login.md");
  const r = applyResults({ runId: "R9", testCaseFile: tcFile, resultsFile: results, evidenceDir: path.join(sp.evidenceDir, "SD-1"), reportLabel: "x/html" });
  assert.deepEqual(r.parsed.stats, { passed: 1, failed: 1, skipped: 0, flaky: 0 });
  assert.deepEqual(r.notRun, ["TC-SD1-E-001"]);
  assert.deepEqual(r.parsed.untraced, ["no id here"]);
  const text = fs.readFileSync(tcFile, "utf-8");
  assert.match(text, /✅ Passed · \d{4}-\d{2}-\d{2} · 1\.2s \| \[screenshot\]\(\.\.\/evidence\/SD-1\/R9\/TC-SD1-S-001\.png\)/);
  assert.match(text, /❌ Failed · \d{4}-\d{2}-\d{2} · Expected: locked/);
  assert.match(text, /## Run History\n\n\| Run \| Date \| Passed \| Failed \| Flaky \| Skipped \| Report \|\n\|---\|---\|---\|---\|---\|---\|---\|\n\| R9 \|/);
  assert.ok(fs.existsSync(path.join(sp.evidenceDir, "SD-1", "R9", "TC-SD1-S-001.png")));
});

test("stepState reads where a story stands", () => {
  const dir = makeProject();
  const s = stepState(aiqaPaths(dir), "SD-1", "Login");
  assert.equal(s.done["story-design"], true);
  assert.equal(s.done["story-explore"], true);
  assert.equal(s.done["story-script"], true);
  assert.equal(s.next, "story-run");
});

test("story.mjs info, finish-design and progress", () => {
  const dir = makeProject();
  const run = (...args) => spawnSync(process.execPath, [STORY_CLI, ...args], { cwd: dir, encoding: "utf-8" });
  const info = JSON.parse(run("info", "SD-1").stdout);
  assert.equal(info.storyHash, STORY_SD1_HASH);
  assert.equal(info.testCaseFile, ".aiqa/test-cases/SD-1-login.md");
  assert.equal(info.specFile, ".aiqa/test-scripts/SD-1-login.spec.ts");
  assert.equal(info.stale, false);
  assert.deepEqual(info.scriptableRows, ["TC-SD1-S-001", "TC-SD1-N-001"]);
  assert.match(info.storyText, /Valid users reach/);

  const missing = run("info", "XY-9");
  assert.equal(missing.status, 2);
  assert.equal(JSON.parse(missing.stdout).error, "no-story-file");
  assert.equal(run("info", "bad key;rm").status, 1);

  const tc = path.join(dir, ".aiqa/test-cases/SD-1-login.md");
  fs.writeFileSync(tc, TEST_CASES_SD1.replace(`storyHash: ${STORY_SD1_HASH}\n`, ""));
  assert.equal(run("finish-design", "SD-1").status, 0);
  assert.equal(parseTestCaseFile(fs.readFileSync(tc, "utf-8")).frontMatter.storyHash, STORY_SD1_HASH);

  assert.equal(run("progress", "SD-1", "story-design", "start", "--run", "R1").status, 0);
  const last = fs.readFileSync(path.join(dir, ".aiqa/progress.jsonl"), "utf-8").trim().split("\n").at(-1);
  assert.deepEqual({ ...JSON.parse(last), ts: undefined }, { ts: undefined, kind: "story", story: "SD-1", step: "story-design", event: "start", run: "R1" });

  assert.equal(run("config", "SD-1", "--url", "https://www.saucedemo.com").status, 0);
  assert.match(fs.readFileSync(path.join(dir, ".aiqa/playwright.stories.config.ts"), "utf-8"), /baseURL: process\.env\.BASE_URL \|\| "https:\/\/www\.saucedemo\.com"/);
});

test("the story config takes testIdAttribute from the project's playwright.config.ts", () => {
  const dir = makeProject();
  const run = (...args) => spawnSync(process.execPath, [STORY_CLI, ...args], { cwd: dir, encoding: "utf-8" });
  const storyConfig = () => {
    assert.equal(run("config", "SD-1", "--url", "https://www.saucedemo.com").status, 0);
    return fs.readFileSync(path.join(dir, ".aiqa/playwright.stories.config.ts"), "utf-8");
  };
  assert.doesNotMatch(storyConfig(), /testIdAttribute/, "no project config: the npm package's story config");

  const projectConfig = path.join(dir, "playwright.config.ts");
  fs.writeFileSync(projectConfig, '  use: {\n    // testIdAttribute: "data-qa",\n    testIdAttribute: \'data-test\',\n  },\n');
  assert.match(storyConfig(), /^ {4}testIdAttribute: "data-test",$/m);

  fs.writeFileSync(projectConfig, '  use: {\n    // testIdAttribute: "data-qa",\n  },\n');
  assert.doesNotMatch(storyConfig(), /testIdAttribute/, "a commented-out setting is ignored");
});

test("models per role: command line, then .aiqa/ai.json, then the session", async () => {
  const { parseModelFlags, resolveRoleModels, writeClaudeModels, readAiSettings, modelAlias } = await import("../.claude/skills/qa-story/scripts/aiqa-files.mjs");
  const dir = makeProject();
  const aiFile = path.join(dir, ".aiqa/ai.json");
  assert.deepEqual(Object.values(resolveRoleModels(dir)).map((r) => r.model), [null, null, null, null, null]);

  // The npm package's own keys survive a save: provider and the Copilot picks.
  fs.writeFileSync(aiFile, JSON.stringify({ provider: "anthropic", models: { "copilot-sdk": { default: "gpt-5" }, anthropic: { analyst: "haiku" } }, junk: 1 }));
  writeClaudeModels(dir, { default: "sonnet", "qa-planner": "claude-opus-4-8", nope: "opus" });
  assert.equal(fs.readFileSync(aiFile, "utf-8"), JSON.stringify({ provider: "anthropic", models: { anthropic: { default: "sonnet", "qa-planner": "claude-opus-4-8" }, "copilot-sdk": { default: "gpt-5" } } }, null, 2) + "\n");
  assert.deepEqual(readAiSettings(dir).models["copilot-sdk"], { default: "gpt-5" });

  const r = resolveRoleModels(dir);
  assert.deepEqual(r["qa-planner"], { model: "opus", source: ".aiqa/ai.json", raw: "claude-opus-4-8" });
  assert.deepEqual(r.analyst, { model: "sonnet", source: ".aiqa/ai.json" }, "a role without its own pick takes the default");

  // --model-<role> wins for that role; --model for every key; a saved role pick still beats a command-line default.
  const flags = parseModelFlags(["--model-qa-reporter", "haiku", "--model-default=opus"]);
  assert.deepEqual(flags, { model: undefined, models: { "qa-reporter": "haiku", default: "opus" }, unknown: [] });
  const r2 = resolveRoleModels(dir, flags);
  assert.equal(r2["qa-reporter"].model, "haiku");
  assert.equal(r2["qa-reporter"].source, "command line");
  assert.equal(r2["qa-planner"].model, "opus");
  assert.equal(r2["qa-planner"].source, ".aiqa/ai.json");
  assert.equal(r2.analyst.model, "opus");
  assert.equal(resolveRoleModels(dir, parseModelFlags(["--model", "haiku"]))["qa-planner"].model, "haiku");
  assert.deepEqual(parseModelFlags(["--model-planner", "opus"]).unknown, ["--model-planner"]);

  assert.equal(modelAlias("sonnet[1m]"), "sonnet");
  writeClaudeModels(dir, { analyst: "gpt-5" });
  assert.equal(resolveRoleModels(dir).analyst.model, null);
  assert.match(resolveRoleModels(dir).analyst.note, /isn't a Claude model/);
});

test("models.mjs and story.mjs info report the models", () => {
  const dir = makeProject();
  fs.writeFileSync(path.join(dir, ".aiqa/ai.json"), JSON.stringify({ models: { anthropic: { analyst: "opus" } } }));
  const MODELS_CLI = fileURLToPath(new URL("../.claude/skills/qa-pipeline/scripts/models.mjs", import.meta.url));
  const out = JSON.parse(spawnSync(process.execPath, [MODELS_CLI, "--model-qa-reviewer", "haiku"], { cwd: dir, encoding: "utf-8" }).stdout);
  assert.equal(out.analyst.model, "opus");
  assert.equal(out["qa-reviewer"].model, "haiku");
  assert.equal(out["qa-planner"].model, null);
  assert.equal(spawnSync(process.execPath, [MODELS_CLI, "--model-planner", "opus"], { cwd: dir }).status, 1);
  const info = JSON.parse(spawnSync(process.execPath, [STORY_CLI, "info", "SD-1"], { cwd: dir, encoding: "utf-8" }).stdout);
  assert.deepEqual(info.models["story-explore"], { role: "analyst", model: "opus", source: ".aiqa/ai.json" });
  assert.equal(info.models["story-design"].model, null);
});
