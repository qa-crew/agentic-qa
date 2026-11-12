#!/usr/bin/env node
// The code-owned parts of AIQA's story workflow, for the qa-story skill. Run from the project root:
//   node story.mjs info <KEY>                    where the story stands, its files and hash (JSON)
//   node story.mjs config <KEY> --url <app>      write .aiqa/playwright.stories.config.ts
//   node story.mjs finish-design <KEY>           write storyHash into the test cases if the agent left it out
//   node story.mjs run <KEY> --url <app>         run the story's tests and write the results into its test cases
//   node story.mjs progress <KEY> <step> <event> append a line to .aiqa/progress.jsonl for the dashboard
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  aiqaPaths, appendProgress, applyResults, hasSource, isTagSafeKey, nothingToAutomate, parseModelFlags, parseSource,
  parseStoryFile, parseTestCaseFile, resolveRoleModels, scriptableRows, setFrontMatterValue, statusCounts, stepDone,
  stepState, STORY_STEP_ROLE, storyFiles, storyGrep, storyHash, writeStoryPlaywrightConfig,
} from "./aiqa-files.mjs";

const [, , command, key, ...rest] = process.argv;
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

const sp = aiqaPaths(process.cwd());
const rel = (p) => path.relative(sp.cwd, p).replace(/\\/g, "/");
const listFiles = (dir, ext) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith(ext)).sort(); } catch { return []; } };

function fail(message, code = 1) {
  console.error(`❌ ${message}`);
  process.exit(code);
}

function readIndexHash(k) {
  try { return JSON.parse(fs.readFileSync(sp.indexFile, "utf-8")).stories?.[k]?.hash; } catch { return undefined; }
}

function context(k) {
  const files = storyFiles(sp, k);
  if (!fs.existsSync(files.storyFile)) {
    return { key: k, error: "no-story-file", storyFile: rel(files.storyFile), storiesDir: rel(sp.storiesDir) };
  }
  const storyText = fs.readFileSync(files.storyFile, "utf-8");
  const parsed = parseStoryFile(storyText, files.storyFile);
  const title = parsed?.title ?? k;
  const hash = readIndexHash(k) ?? (parsed ? storyHash(parsed) : "");
  const tcExists = fs.existsSync(files.testCaseFile);
  const cases = tcExists ? parseTestCaseFile(fs.readFileSync(files.testCaseFile, "utf-8")) : undefined;
  const designedFrom = cases?.frontMatter.storyHash;
  const sourced = { spec: 0, alm: 0, csv: 0 };
  for (const r of cases?.table?.rows ?? []) {
    const src = hasSource(r.cells.Source) ? parseSource(r.cells.Source) : undefined;
    if (src) sourced[src.kind]++;
  }
  // Each agent step runs on its role's model (Design = qa-planner, Explore = analyst, Automate = qa-engineer).
  const roleModels = resolveRoleModels(sp.cwd, parseModelFlags(rest));
  const models = Object.fromEntries(Object.entries(STORY_STEP_ROLE).map(([step, role]) => [step, { role, ...roleModels[role] }]));
  return {
    key: k,
    title,
    acceptanceCriteria: parsed?.acceptanceCriteria.length ?? 0,
    storyHash: hash,
    storyFile: rel(files.storyFile),
    testCaseFile: rel(files.testCaseFile),
    specFile: rel(files.specFile),
    snapshotsDir: rel(files.snapshotsDir),
    evidenceDir: rel(files.evidenceDir),
    playwrightConfig: rel(sp.playwrightConfig),
    testCasesExist: tcExists,
    stale: !!designedFrom && !!hash && designedFrom !== hash,
    sourced,
    statusCounts: statusCounts(cases?.table),
    scriptableRows: scriptableRows(cases),
    nothingToAutomate: nothingToAutomate(cases),
    snapshots: listFiles(files.snapshotsDir, ".yml"),
    pageObjects: listFiles(sp.pagesDir, ".page.ts"),
    stage: stepState(sp, k, title),
    models,
    storyText,
  };
}

function playwrightInstalled() {
  try {
    createRequire(path.join(sp.cwd, "package.json")).resolve("@playwright/test");
    return true;
  } catch {
    return false;
  }
}

function runTests(k, files) {
  for (const d of [path.dirname(files.resultsFile), files.outputDir]) fs.mkdirSync(d, { recursive: true });
  try { fs.rmSync(files.resultsFile, { force: true }); } catch {}
  const filter = `"${path.basename(files.specFile).replace(/\./g, "\\.")}"`;
  const cmd = `npx playwright test -c "${rel(sp.playwrightConfig)}" ${filter} --grep "${storyGrep(k)}" --project=chromium`;
  console.log(`   $ ${cmd}`);
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      cwd: sp.cwd,
      shell: true,
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        AIQA_STORY_RESULTS: files.resultsFile,
        AIQA_STORY_HTML: files.reportDir,
        AIQA_STORY_OUTPUT: files.outputDir,
        FORCE_COLOR: "0",
      },
    });
    child.on("error", () => resolve({ exitCode: 1, cmd }));
    child.on("close", (code) => resolve({ exitCode: code ?? 1, cmd }));
  });
}

async function run(k, url) {
  if (!url) fail("No application URL: pass --url <app-url>.");
  if (!playwrightInstalled()) fail("@playwright/test isn't installed in this project — run: npm install --save-dev @playwright/test && npx playwright install chromium");
  const files = storyFiles(sp, k);
  if (!fs.existsSync(files.specFile)) fail(`No spec for ${k} yet (${rel(files.specFile)}) — run the Automate step first.`);
  if (!fs.existsSync(files.testCaseFile)) fail(`No test-case file for ${k} — run the Design step first.`);
  writeStoryPlaywrightConfig(sp, url);
  const runId = flag("run-id") ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runStart = Date.now();
  console.log(`   🧪 Running ${k}'s tests…`);
  const result = await runTests(k, files);
  if (!stepDone("story-run", files, k, runStart)) fail(`Playwright produced no results (exit ${result.exitCode}). Command: ${result.cmd}`);
  const applied = applyResults({
    runId, testCaseFile: files.testCaseFile, resultsFile: files.resultsFile,
    evidenceDir: files.evidenceDir, reportLabel: rel(files.reportDir),
  });
  const s = applied.parsed.stats;
  try {
    const index = JSON.parse(fs.readFileSync(sp.indexFile, "utf-8"));
    if (index.stories?.[k]) {
      index.stories[k].lastRun = { runId, at: new Date().toISOString(), ...s };
      fs.writeFileSync(sp.indexFile, JSON.stringify(index, null, 2) + "\n", "utf-8");
    }
  } catch {}
  const total = s.passed + s.failed + s.flaky + s.skipped;
  console.log(`\n   📊 Ran ${total} test(s): ${s.passed} passed, ${s.failed} failed${s.flaky ? `, ${s.flaky} flaky` : ""}${s.skipped ? `, ${s.skipped} skipped` : ""} · ${applied.screenshots} screenshot(s) saved`);
  console.log(`   📝 Results written into ${rel(files.testCaseFile)} (Last Result / Evidence columns + Run History)`);
  console.log(`   📄 HTML report: npx playwright show-report ${rel(files.reportDir)}`);
  if (applied.notRun.length) console.log(`   ℹ️  Not run: ${applied.notRun.join(", ")} (not automated, fixme, or filtered)`);
  if (applied.parsed.untraced.length) console.log(`   ⚠️  ${applied.parsed.untraced.length} test(s) have no TC id in their title, so they can't be written back.`);
}

if (!command || !key) {
  console.log("Usage: node story.mjs <info|config|finish-design|run|progress> <KEY> [--url <app-url>]");
  process.exit(command ? 1 : 0);
}
if (!isTagSafeKey(key)) fail(`"${key}" isn't a valid story key (letters, digits and single hyphens, starting with a letter).`);

switch (command) {
  case "info": {
    const c = context(key);
    console.log(JSON.stringify(c, null, 2));
    if (c.error) process.exit(2);
    break;
  }
  case "config": {
    const url = flag("url");
    if (!url) fail("No application URL: pass --url <app-url>.");
    console.log(`Wrote ${rel(writeStoryPlaywrightConfig(sp, url))}`);
    break;
  }
  case "finish-design": {
    const c = context(key);
    if (c.error || !c.testCasesExist) fail(`No test-case file for ${key}.`);
    const file = path.join(sp.cwd, c.testCaseFile);
    const text = fs.readFileSync(file, "utf-8");
    if (c.storyHash && parseTestCaseFile(text).frontMatter.storyHash !== c.storyHash) {
      fs.writeFileSync(file, setFrontMatterValue(text, "storyHash", c.storyHash), "utf-8");
      console.log(`Wrote storyHash ${c.storyHash} into ${c.testCaseFile}`);
    } else console.log("storyHash already up to date");
    break;
  }
  case "run":
    await run(key, flag("url"));
    break;
  case "progress": {
    const [step, event] = rest;
    if (!step || !event) fail("Usage: node story.mjs progress <KEY> <step> <event> [--run <id>] [--note <text>]");
    appendProgress(sp, { kind: "story", story: key, step, event, run: flag("run"), note: flag("note") });
    break;
  }
  default:
    fail(`Unknown command "${command}".`);
}
