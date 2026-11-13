// Builds the dashboard's view of a project from the files under .aiqa/ only. Never writes anything.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  aiqaPaths, keyFromFileName, parseFrontMatter, parseResultsJson, parseStoryFile, parseTestCaseFile, statusCounts,
  stepState, storyFiles, storyHash, STORY_STEPS,
} from "../../qa-story/scripts/aiqa-files.mjs";
import { inline, renderMarkdown, sectionText, stripFrontMatter } from "./md.mjs";

export const SUITE_STEPS = [
  { id: "analyst", name: "Analyst", role: "Explores the app, saves snapshots, writes the requirements", output: ".aiqa/requirements/requirements.md" },
  { id: "qa-planner", name: "QA Planner", role: "Risk-based test plan from the requirements and snapshots", output: ".aiqa/test-plan/test_plan.md" },
  { id: "qa-engineer", name: "QA Engineer", role: "Test cases, page objects, fixtures and specs", output: ".aiqa/test-scripts" },
  { id: "qa-reviewer", name: "QA Reviewer", role: "Checks every selector against the snapshots", output: ".aiqa/reports/review_report.md" },
  { id: "qa-reporter", name: "QA Reporter", role: "Runs the suite and writes the executive report", output: ".aiqa/reports/summary_report.md" },
];

export const STORY_STEP_META = {
  "story-pull": { name: "Pull", role: "The story file in .aiqa/stories/" },
  "story-design": { name: "Design", role: "Manual test cases from the acceptance criteria" },
  "story-explore": { name: "Explore", role: "Walks the cases in the app, saves snapshots" },
  "story-script": { name: "Automate", role: "Playwright tests for the verified cases" },
  "story-run": { name: "Run", role: "Results and screenshots written into the cases" },
};

const posix = (p) => p.replace(/\\/g, "/");

function fileInfo(cwd, rel) {
  try {
    const st = fs.statSync(path.join(cwd, rel));
    return { path: rel, exists: true, size: st.size, mtime: st.mtime.toISOString(), dir: st.isDirectory() };
  } catch {
    return { path: rel, exists: false };
  }
}

function list(cwd, rel, ext) {
  try {
    return fs.readdirSync(path.join(cwd, rel)).filter((f) => f.endsWith(ext)).sort().map((f) => `${rel}/${f}`);
  } catch {
    return [];
  }
}

/** progress.jsonl lines, oldest first. Lines that don't parse are skipped. */
export function readProgress(cwd) {
  try {
    return fs.readFileSync(path.join(cwd, ".aiqa", "progress.jsonl"), "utf-8").split(/\r?\n/).flatMap((l) => {
      try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; }
    });
  } catch {
    return [];
  }
}

const EVENT_STATE = { start: "running", done: "done", failed: "failed", skipped: "skipped", paused: "paused" };

/** Each step's state from its progress lines: the last event wins; durations from start → done. */
function stepsFromProgress(events) {
  const steps = {};
  for (const e of events) {
    const s = (steps[e.step] ??= {});
    if (e.event === "start") { s.startedAt = e.ts; s.endedAt = undefined; s.note = undefined; s.run = e.run; }
    else s.endedAt = e.ts;
    s.state = EVENT_STATE[e.event] ?? e.event;
    if (e.note) s.note = e.note;
    if (s.startedAt && s.endedAt) s.durationMs = Date.parse(s.endedAt) - Date.parse(s.startedAt);
  }
  return steps;
}

/** Playwright's JSON report → totals, per file, and the failures. */
export function summarizeResults(cwd, rel) {
  const info = fileInfo(cwd, rel);
  if (!info.exists) return undefined;
  let report;
  try { report = JSON.parse(fs.readFileSync(path.join(cwd, rel), "utf-8")); } catch { return { ...info, error: "unreadable" }; }
  const files = {};
  const failures = [];
  const walk = (suite, file, titles) => {
    const f = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const last = (test.results ?? []).at(-1);
        const outcome = test.status === "flaky" ? "flaky" : test.status === "skipped" || last?.status === "skipped" ? "skipped" : test.status === "expected" ? "passed" : "failed";
        const row = (files[f] ??= { file: f, passed: 0, failed: 0, skipped: 0, flaky: 0 });
        row[outcome]++;
        if (outcome === "failed") {
          const msg = String(last?.error?.message ?? last?.errors?.[0]?.message ?? "").replace(/\x1b\[[0-9;]*m/g, "");
          failures.push({ title: [...titles, spec.title].filter(Boolean).join(" › "), file: f, error: msg.split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 300) ?? "" });
        }
      }
    }
    for (const child of suite.suites ?? []) walk(child, f, [...titles, child.title && child.title !== f ? child.title : ""].filter(Boolean));
  };
  for (const s of report.suites ?? []) walk(s, s.file ?? s.title, []);
  const rows = Object.values(files);
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  return {
    ...info,
    stats: { passed: sum("passed"), failed: sum("failed"), skipped: sum("skipped"), flaky: sum("flaky") },
    durationMs: Number(report.stats?.duration) || undefined,
    startedAt: report.stats?.startTime,
    files: rows,
    failures: failures.slice(0, 50),
  };
}

function suiteState(cwd, events, keys) {
  const suiteEvents = events.filter((e) => e.kind === "suite");
  const starts = suiteEvents.filter((e) => e.step === "pipeline" && e.event === "start");
  const runStart = starts.at(-1);
  const runEvents = runStart ? suiteEvents.filter((e) => e.run === runStart.run) : [];
  const progress = stepsFromProgress(runEvents.filter((e) => e.step !== "pipeline"));
  const pipelineEnd = runEvents.filter((e) => e.step === "pipeline" && e.event !== "start").at(-1);

  const isStorySpec = (f) => keys.some((k) => path.basename(f).startsWith(`${k}-`) || path.basename(f) === `${k}.spec.ts`);
  const specs = list(cwd, ".aiqa/test-scripts", ".spec.ts").filter((f) => !isStorySpec(f));
  const steps = SUITE_STEPS.map((s) => {
    const out = s.id === "qa-engineer" ? { path: ".aiqa/test-scripts", exists: specs.length > 0 } : fileInfo(cwd, s.output);
    const p = progress[s.id];
    // Without progress lines (the agents were run by hand) a step counts as done once its output exists.
    const state = p?.state ?? (out.exists ? "done" : "pending");
    return { ...s, ...p, state, outputInfo: out };
  });

  const testCases = list(cwd, ".aiqa/test-cases", ".md").flatMap((f) => {
    try {
      const text = fs.readFileSync(path.join(cwd, f), "utf-8");
      if (parseFrontMatter(text).data.story) return [];
      const rows = (text.match(/^\|\s*TC-[A-Za-z0-9]+-[A-Za-z]-\d+/gm) ?? []).length;
      return [{ path: f, title: text.match(/^#\s+(.+)$/m)?.[1] ?? path.basename(f, ".md"), cases: rows }];
    } catch {
      return [];
    }
  });

  return {
    run: runStart ? { run: runStart.run, target: runStart.target, filter: runStart.filter, startedAt: runStart.ts, endedAt: pipelineEnd?.ts, state: pipelineEnd ? EVENT_STATE[pipelineEnd.event] ?? pipelineEnd.event : "running" } : undefined,
    steps,
    documents: [
      { label: "Requirements", ...fileInfo(cwd, ".aiqa/requirements/requirements.md") },
      { label: "Test plan", ...fileInfo(cwd, ".aiqa/test-plan/test_plan.md") },
      { label: "Review report", ...fileInfo(cwd, ".aiqa/reports/review_report.md") },
      { label: "Summary report", ...fileInfo(cwd, ".aiqa/reports/summary_report.md") },
    ].filter((d) => d.exists),
    testCases,
    specs,
    pageObjects: list(cwd, ".aiqa/test-scripts/pages", ".page.ts"),
    snapshots: list(cwd, ".aiqa/snapshots", ".yml"),
    config: fileInfo(cwd, "playwright.config.ts"),
    results: summarizeResults(cwd, ".aiqa/reports/test-results/results.json"),
    htmlReport: fileInfo(cwd, ".aiqa/reports/playwright-report/index.html"),
    performanceReport: fileInfo(cwd, ".aiqa/reports/performance/performance-report.html"),
  };
}

function lastRunRow(text) {
  const body = sectionText(text, "Run History");
  const rows = body.split(/\r?\n/).filter((l) => /^\|\s*[^|-]/.test(l.trim()) && !/^\|\s*Run\s*\|/i.test(l.trim()));
  const last = rows.at(-1);
  if (!last) return undefined;
  const [run, date, passed, failed, flaky, skipped] = last.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  return { run, date, passed: Number(passed) || 0, failed: Number(failed) || 0, flaky: Number(flaky) || 0, skipped: Number(skipped) || 0 };
}

export function storyKeys(cwd) {
  const sp = aiqaPaths(cwd);
  const keys = new Set();
  for (const dir of [sp.storiesDir, sp.testCasesDir]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".md")) continue;
        const text = fs.readFileSync(path.join(dir, f), "utf-8");
        const fm = parseFrontMatter(text).data;
        const key = dir === sp.storiesDir ? fm.key || keyFromFileName(f) : fm.story;
        if (key) keys.add(key);
      }
    } catch {}
  }
  return [...keys].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function storySummary(cwd, key, events) {
  const sp = aiqaPaths(cwd);
  const files = storyFiles(sp, key);
  let title = key;
  let hash = "";
  try {
    const item = parseStoryFile(fs.readFileSync(files.storyFile, "utf-8"), files.storyFile);
    if (item) { title = item.title; hash = storyHash(item); }
  } catch {}
  try { hash = JSON.parse(fs.readFileSync(sp.indexFile, "utf-8")).stories?.[key]?.hash ?? hash; } catch {}
  let tcText = "";
  try { tcText = fs.readFileSync(files.testCaseFile, "utf-8"); } catch {}
  const parsed = tcText ? parseTestCaseFile(tcText) : undefined;
  if (title === key && parsed?.frontMatter.title) title = parsed.frontMatter.title;
  const stage = stepState(sp, key, title);
  const storyEvents = events.filter((e) => e.kind === "story" && e.story === key);
  const progress = stepsFromProgress(storyEvents);
  // A step still "running" from an older run was cut off: its session stopped before the step ended (a usage limit,
  // a closed terminal). Show what the files say about it instead, with no time.
  const latestRun = storyEvents.at(-1)?.run;
  for (const p of Object.values(progress)) {
    if (p.state === "running" && p.run !== latestRun) { delete p.state; delete p.startedAt; }
  }
  const running = Object.entries(progress).find(([, p]) => p.state === "running")?.[0];
  return {
    key,
    title,
    files: {
      story: posix(path.relative(cwd, files.storyFile)),
      testCases: posix(path.relative(cwd, files.testCaseFile)),
      spec: posix(path.relative(cwd, files.specFile)),
      snapshots: posix(path.relative(cwd, files.snapshotsDir)),
    },
    exists: { story: fs.existsSync(files.storyFile), testCases: !!tcText, spec: fs.existsSync(files.specFile) },
    steps: STORY_STEPS.map((id) => ({ id, ...STORY_STEP_META[id], done: stage.done[id], notNeeded: stage.notNeeded[id], ...progress[id] })),
    next: stage.next,
    review: stage.review,
    running,
    counts: statusCounts(parsed?.table),
    total: parsed?.table?.rows.length ?? 0,
    stale: !!parsed?.frontMatter.storyHash && !!hash && parsed.frontMatter.storyHash !== hash,
    lastRun: tcText ? lastRunRow(tcText) : undefined,
  };
}

/** Everything the dashboard shows on its main views. */
export function buildState(cwd) {
  const events = readProgress(cwd);
  const keys = storyKeys(cwd);
  return {
    project: path.basename(cwd),
    generatedAt: new Date().toISOString(),
    hasAiqa: fs.existsSync(path.join(cwd, ".aiqa")),
    suite: suiteState(cwd, events, keys),
    stories: keys.map((k) => storySummary(cwd, k, events)),
  };
}

/** One story in detail: its sections, the test-case rows, snapshots and results. */
export function buildStory(cwd, key) {
  const summary = storySummary(cwd, key, readProgress(cwd));
  const sp = aiqaPaths(cwd);
  const files = storyFiles(sp, key);
  let story = "";
  let tc = "";
  try { story = fs.readFileSync(files.storyFile, "utf-8"); } catch {}
  try { tc = fs.readFileSync(files.testCaseFile, "utf-8"); } catch {}
  const parsed = tc ? parseTestCaseFile(tc) : undefined;
  const html = (md) => (md ? renderMarkdown(md) : "");
  return {
    ...summary,
    storyHtml: story ? html(stripFrontMatter(story).replace(/^#\s+.+$/m, "")) : "",
    criteriaHtml: html(sectionText(tc, "Testable Acceptance Criteria")),
    questionsHtml: html(sectionText(tc, "Open Questions")),
    notesHtml: html(sectionText(tc, "Exploration Notes")),
    historyHtml: html(sectionText(tc, "Run History")),
    headers: parsed?.table?.headers ?? [],
    rows: parsed?.table?.rows.map((r) => ({ cells: r.cells, html: Object.fromEntries(parsed.table.headers.map((h) => [h, inline((r.cells[h] ?? "").replace(/\\\|/g, "|"))])) })) ?? [],
    snapshots: list(cwd, posix(path.relative(cwd, files.snapshotsDir)), ".yml"),
    results: summarizeResults(cwd, posix(path.relative(cwd, files.resultsFile))),
    htmlReport: fileInfo(cwd, posix(path.relative(cwd, path.join(files.reportDir, "index.html")))),
  };
}
