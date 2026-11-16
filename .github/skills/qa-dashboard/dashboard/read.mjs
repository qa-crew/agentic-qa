// Builds the dashboard's view of a project from the files under .agentic-qa/ only. Never writes anything.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  extractTcId, qaPaths, keyFromFileName, parseFrontMatter, parseResultsJson, parseStoryFile, parseTestCaseFile, statusCounts,
  stepState, storyFiles, storyHash, STORY_STEPS,
} from "../../qa-story/scripts/qa-files.mjs";
import { inline, renderMarkdown, sectionText, stripFrontMatter } from "./md.mjs";

export const SUITE_STEPS = [
  { id: "analyst", name: "Analyst", role: "Explores the app, saves snapshots, writes the requirements", output: ".agentic-qa/requirements/requirements.md" },
  { id: "qa-planner", name: "QA Planner", role: "Risk-based test plan from the requirements and snapshots", output: ".agentic-qa/test-plan/test_plan.md" },
  { id: "qa-engineer", name: "QA Engineer", role: "Test cases, page objects, fixtures and specs", output: ".agentic-qa/test-scripts" },
  { id: "qa-reviewer", name: "QA Reviewer", role: "Checks every selector against the snapshots", output: ".agentic-qa/reports/review_report.md" },
  { id: "qa-reporter", name: "QA Reporter", role: "Runs the suite and writes the executive report", output: ".agentic-qa/reports/summary_report.md" },
];

export const STORY_STEP_META = {
  "story-pull": { name: "Pull", role: "The story file in .agentic-qa/stories/" },
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
    return fs.readFileSync(path.join(cwd, ".agentic-qa", "progress.jsonl"), "utf-8").split(/\r?\n/).flatMap((l) => {
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

/** An image attachment's path, relative to the project, when it's inside .agentic-qa/ (the only place the dashboard serves). */
function attachmentPath(cwd, results) {
  const shot = results.flatMap((r) => (r.attachments ?? []).filter((a) => a?.path && /^image\//.test(a.contentType ?? ""))).at(-1);
  if (!shot) return undefined;
  const rel = posix(path.relative(cwd, path.resolve(cwd, shot.path)));
  return rel.startsWith(".agentic-qa/") ? rel : undefined;
}

/** Every test-case row in .agentic-qa/test-cases/, by ID, so a failing test can show the manual case it automates.
 *  Reads any Markdown table whose first column holds TC IDs, so the full suite's simpler tables count too. */
export function testCaseIndex(cwd) {
  const index = {};
  for (const f of list(cwd, ".agentic-qa/test-cases", ".md")) {
    let text;
    try { text = fs.readFileSync(path.join(cwd, f), "utf-8"); } catch { continue; }
    const story = parseFrontMatter(text).data.story;
    const lines = text.split(/\r?\n/);
    let headers;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l.startsWith("|")) { headers = undefined; continue; }
      const cells = l.replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim());
      if (/^\|\s*:?-{3,}/.test(lines[i + 1]?.trim() ?? "")) { headers = cells; i++; continue; }
      if (!headers || !/^TC-[A-Za-z0-9]+-[A-Za-z]-\d+$/.test(cells[0]) || index[cells[0]]) continue;
      const row = Object.fromEntries(headers.map((h, j) => [h, cells[j] ?? ""]));
      const cell = (h) => (row[h] && row[h] !== "—" ? inline(row[h].replace(/\\\|/g, "|")) : "");
      index[cells[0]] = { id: cells[0], file: f, story, title: cell("Title"), steps: cell("Steps"), expected: cell("Expected"), status: row.Status };
    }
  }
  return index;
}

/** Playwright's JSON report → totals, per file, the failures and the flaky tests. */
export function summarizeResults(cwd, rel, cases) {
  const info = fileInfo(cwd, rel);
  if (!info.exists) return undefined;
  let report;
  try { report = JSON.parse(fs.readFileSync(path.join(cwd, rel), "utf-8")); } catch { return { ...info, error: "unreadable" }; }
  const files = {};
  const failures = [];
  const flaky = [];
  const walk = (suite, file, titles) => {
    const f = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const results = test.results ?? [];
        const last = results.at(-1);
        const outcome = test.status === "flaky" ? "flaky" : test.status === "skipped" || last?.status === "skipped" ? "skipped" : test.status === "expected" ? "passed" : "failed";
        const row = (files[f] ??= { file: f, passed: 0, failed: 0, skipped: 0, flaky: 0, durationMs: 0 });
        row[outcome]++;
        row.durationMs += results.reduce((a, r) => a + (Number(r.duration) || 0), 0);
        const title = [...titles, spec.title].filter(Boolean).join(" › ");
        const tcId = extractTcId(String(spec.title ?? "")) ?? extractTcId(title);
        const testCase = tcId && cases?.[tcId] ? cases[tcId] : undefined;
        if (outcome === "failed") {
          const msg = String(last?.error?.message ?? last?.errors?.[0]?.message ?? "").replace(/\x1b\[[0-9;]*m/g, "");
          const lines = msg.split(/\r?\n/).map((l) => l.trimEnd());
          failures.push({ title, file: f, tcId, testCase, screenshot: attachmentPath(cwd, results), error: lines.find((l) => l.trim())?.trim().slice(0, 300) ?? "", detail: lines.filter((l) => l.trim()).slice(0, 12).join("\n").slice(0, 1500) });
        } else if (outcome === "flaky") {
          flaky.push({ title, file: f, tcId, testCase, retries: Math.max(0, results.length - 1) });
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
    flaky: flaky.slice(0, 50),
  };
}

function suiteState(cwd, events, keys, cases) {
  const suiteEvents = events.filter((e) => e.kind === "suite");
  const starts = suiteEvents.filter((e) => e.step === "pipeline" && e.event === "start");
  const runStart = starts.at(-1);
  const runEvents = runStart ? suiteEvents.filter((e) => e.run === runStart.run) : [];
  const progress = stepsFromProgress(runEvents.filter((e) => e.step !== "pipeline"));
  const pipelineEnd = runEvents.filter((e) => e.step === "pipeline" && e.event !== "start").at(-1);

  const isStorySpec = (f) => keys.some((k) => path.basename(f).startsWith(`${k}-`) || path.basename(f) === `${k}.spec.ts`);
  const specs = list(cwd, ".agentic-qa/test-scripts", ".spec.ts").filter((f) => !isStorySpec(f));
  const steps = SUITE_STEPS.map((s) => {
    const out = s.id === "qa-engineer" ? { path: ".agentic-qa/test-scripts", exists: specs.length > 0 } : fileInfo(cwd, s.output);
    const p = progress[s.id];
    // Without progress lines (the agents were run by hand) a step counts as done once its output exists.
    const state = p?.state ?? (out.exists ? "done" : "pending");
    return { ...s, ...p, state, outputInfo: out };
  });

  const testCases = list(cwd, ".agentic-qa/test-cases", ".md").flatMap((f) => {
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
      { label: "Requirements", ...fileInfo(cwd, ".agentic-qa/requirements/requirements.md") },
      { label: "Test plan", ...fileInfo(cwd, ".agentic-qa/test-plan/test_plan.md") },
      { label: "Review report", ...fileInfo(cwd, ".agentic-qa/reports/review_report.md") },
      { label: "Summary report", ...fileInfo(cwd, ".agentic-qa/reports/summary_report.md") },
    ].filter((d) => d.exists),
    testCases,
    specs,
    pageObjects: list(cwd, ".agentic-qa/test-scripts/pages", ".page.ts"),
    snapshots: list(cwd, ".agentic-qa/snapshots", ".yml"),
    config: fileInfo(cwd, "playwright.config.ts"),
    results: summarizeResults(cwd, ".agentic-qa/reports/test-results/results.json", cases),
    htmlReport: fileInfo(cwd, ".agentic-qa/reports/playwright-report/index.html"),
    performanceReport: fileInfo(cwd, ".agentic-qa/reports/performance/performance-report.html"),
  };
}

/** The Run History table's rows, oldest first. */
function runRows(text) {
  const body = sectionText(text, "Run History");
  const rows = body.split(/\r?\n/).filter((l) => /^\|\s*[^|-]/.test(l.trim()) && !/^\|\s*Run\s*\|/i.test(l.trim()));
  return rows.map((l) => {
    const [run, date, passed, failed, flaky, skipped] = l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    return { run, date, passed: Number(passed) || 0, failed: Number(failed) || 0, flaky: Number(flaky) || 0, skipped: Number(skipped) || 0 };
  });
}

export function storyKeys(cwd) {
  const sp = qaPaths(cwd);
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
  const sp = qaPaths(cwd);
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
    lastRun: tcText ? runRows(tcText).at(-1) : undefined,
    runs: tcText ? runRows(tcText).slice(-10) : [],
  };
}

/** The latest progress lines, newest first: what each step did and when. */
function activity(events) {
  return events.filter((e) => e.step && e.event && e.ts).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).slice(-30).reverse()
    .map((e) => ({ ts: e.ts, kind: e.kind, story: e.story, step: e.step, event: e.event, note: e.note, target: e.target }));
}

/** "- **AC1** — text" lines → [{ id, html }]. */
function criteriaList(md) {
  return md.split(/\r?\n/).flatMap((l) => {
    const m = l.match(/^\s*[-*]\s+\*\*(AC\d+)\*\*\s*[—:–-]?\s*(.*)$/);
    return m ? [{ id: m[1], html: inline(m[2]) }] : [];
  });
}

/** Lines of the Exploration Notes that name a test case, by its ID. */
function notesByCase(md, ids) {
  const out = {};
  const lines = md.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim()).filter(Boolean);
  for (const id of ids) {
    const lead = new RegExp(`^[*_\`]*${id}[*_\`]*\\s*[:—–-]?\\s*`);
    const hits = lines.filter((l) => l.includes(id)).map((l) => inline(l.replace(lead, "").replace(/^[a-z]/, (c) => c.toUpperCase())));
    if (hits.length) out[id] = hits;
  }
  return out;
}

/** Everything the dashboard shows on its main views. */
export function buildState(cwd) {
  const events = readProgress(cwd);
  const keys = storyKeys(cwd);
  return {
    project: path.basename(cwd),
    generatedAt: new Date().toISOString(),
    hasData: fs.existsSync(path.join(cwd, ".agentic-qa")),
    suite: suiteState(cwd, events, keys, testCaseIndex(cwd)),
    stories: keys.map((k) => storySummary(cwd, k, events)),
    activity: activity(events),
  };
}

/** One story in detail: its sections, the test-case rows, snapshots and results. */
export function buildStory(cwd, key) {
  const summary = storySummary(cwd, key, readProgress(cwd));
  const sp = qaPaths(cwd);
  const files = storyFiles(sp, key);
  let story = "";
  let tc = "";
  try { story = fs.readFileSync(files.storyFile, "utf-8"); } catch {}
  try { tc = fs.readFileSync(files.testCaseFile, "utf-8"); } catch {}
  const parsed = tc ? parseTestCaseFile(tc) : undefined;
  const html = (md) => (md ? renderMarkdown(md) : "");
  const resultsRel = posix(path.relative(cwd, files.resultsFile));
  let byCase = {};
  try {
    for (const r of parseResultsJson(JSON.parse(fs.readFileSync(files.resultsFile, "utf-8"))).results) {
      byCase[r.tcId] = { outcome: r.outcome, durationMs: r.durationMs, error: r.error, screenshot: attachmentPath(cwd, [{ attachments: r.screenshot ? [{ path: r.screenshot, contentType: "image/png" }] : [] }]) };
    }
  } catch { byCase = {}; }
  const notes = sectionText(tc, "Exploration Notes");
  return {
    ...summary,
    storyHtml: story ? html(stripFrontMatter(story).replace(/^#\s+.+$/m, "")) : "",
    criteriaHtml: html(sectionText(tc, "Testable Acceptance Criteria")),
    criteria: criteriaList(sectionText(tc, "Testable Acceptance Criteria")),
    notesByCase: notesByCase(notes, parsed?.table?.rows.map((r) => r.cells.ID).filter(Boolean) ?? []),
    resultsByCase: byCase,
    questionsHtml: html(sectionText(tc, "Open Questions")),
    notesHtml: html(notes),
    historyHtml: html(sectionText(tc, "Run History")),
    headers: parsed?.table?.headers ?? [],
    rows: parsed?.table?.rows.map((r) => ({ cells: r.cells, html: Object.fromEntries(parsed.table.headers.map((h) => [h, inline((r.cells[h] ?? "").replace(/\\\|/g, "|"))])) })) ?? [],
    snapshots: list(cwd, posix(path.relative(cwd, files.snapshotsDir)), ".yml"),
    results: summarizeResults(cwd, resultsRel, testCaseIndex(cwd)),
    htmlReport: fileInfo(cwd, posix(path.relative(cwd, path.join(files.reportDir, "index.html")))),
  };
}
