// Builds the dashboard's view of a project from the files under .agentic-qa/ only. Never writes anything.
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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

const STEP_IDS = SUITE_STEPS.map((s) => s.id);

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

const EVENT_STATE = { start: "running", done: "done", failed: "failed", skipped: "skipped", paused: "paused", resume: "running" };

/** Each step's state from its progress lines: the last event wins; durations from start → done. */
function stepsFromProgress(events) {
  const steps = {};
  for (const e of events) {
    const s = (steps[e.step] ??= {});
    if (e.event === "start") { s.startedAt = e.ts; s.endedAt = undefined; s.note = undefined; s.run = e.run; s.model = e.model; s.provider = e.provider; }
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

/**
 * A story's open questions (the "Open Questions" list in its test-case file), each with a short id from its text and
 * whether it was ticked as answered (front matter "answered: <id>, <id>"). "None" isn't a question.
 */
export function questionList(tcText) {
  const answered = new Set(String(parseFrontMatter(tcText).data.answered ?? "").split(/[\s,]+/).filter(Boolean));
  return sectionText(tcText, "Open Questions").split(/\r?\n/).flatMap((l) => {
    const m = l.match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (!m || /^none\.?$/i.test(m[1])) return [];
    const id = createHash("sha1").update(m[1].replace(/\s+/g, " ").trim()).digest("hex").slice(0, 8);
    return [{ id, text: m[1], answered: answered.has(id) }];
  });
}

/** .agentic-qa/workspace.json (the project's app URL, shared with the qa-story skill), or {}. */
export function readWorkspace(cwd) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(cwd, ".agentic-qa", "workspace.json"), "utf-8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

/**
 * Whether the full suite's snapshots are shared through git, so teammates reuse them instead of capturing them again.
 * Read-only git only (ls-files): { inGit, total, committed, changed, notCommitted, ignored }, or { inGit: false }
 * outside a repository (or without git). Cached for 30 s, since the page asks every 2 s.
 */
const shareCache = new Map();
export function snapshotShare(cwd, { fresh = false } = {}) {
  const hit = shareCache.get(cwd);
  if (hit && !fresh && Date.now() - hit.at < 30_000) return hit.value;
  const git = (...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  const ymls = (out) => out.split(/\r?\n/).filter((l) => /^\.agentic-qa\/snapshots\/[^/]+\.yml$/.test(l)).length;
  let value;
  try {
    if (git("rev-parse", "--is-inside-work-tree").trim() !== "true") throw new Error("not a repo");
    const dir = ".agentic-qa/snapshots";
    const committed = ymls(git("ls-files", "--", dir));
    const changed = ymls(git("ls-files", "--modified", "--", dir));
    const notCommitted = ymls(git("ls-files", "--others", "--exclude-standard", "--", dir));
    const ignored = ymls(git("ls-files", "--others", "--ignored", "--exclude-standard", "--", dir));
    value = { inGit: true, total: committed + notCommitted + ignored, committed, changed, notCommitted, ignored };
  } catch {
    value = { inGit: false };
  }
  shareCache.set(cwd, { at: Date.now(), value });
  return value;
}

/** The tokens in some "usage" progress lines (written when a dashboard session ends), or undefined when there are none. */
function sumTokens(lines) {
  return lines.length ? lines.reduce((a, e) => a + (Number(e.total) || 0), 0) : undefined;
}

/** A story's latest activity feed from the dashboard (.agentic-qa/logs/<run>/<KEY>.events.jsonl), or undefined. */
function storyFeed(cwd, key) {
  try {
    const runs = fs.readdirSync(path.join(cwd, ".agentic-qa", "logs")).sort().reverse();
    const run = runs.find((r) => fs.existsSync(path.join(cwd, ".agentic-qa", "logs", r, `${key}.events.jsonl`)));
    return run ? `.agentic-qa/logs/${run}/${key}.events.jsonl` : undefined;
  } catch {
    return undefined;
  }
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
    // Without progress lines (the agents were run by hand) a step counts as done once its output exists. Within a run,
    // a step it hasn't reached yet is pending, even when an earlier run left its output behind.
    const state = p?.state ?? (out.exists && !runStart ? "done" : "pending");
    // Tokens the step's sessions used in this run, and its activity feed for the run panel (both from the dashboard).
    const tokens = runStart ? sumTokens(events.filter((e) => e.kind === "usage" && e.run === runStart.run && e.step === s.id)) : undefined;
    const feed = runStart ? `.agentic-qa/logs/${runStart.run}/${s.id}.events.jsonl` : undefined;
    return { ...s, ...p, state, outputInfo: out, tokens, feed: feed && fs.existsSync(path.join(cwd, feed)) ? feed : undefined };
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
    run: runStart ? {
      run: runStart.run, target: runStart.target, filter: runStart.filter, mode: runStart.mode, source: runStart.source,
      startedAt: runStart.ts, endedAt: pipelineEnd?.event === "resume" ? undefined : pipelineEnd?.ts,
      state: pipelineEnd ? EVENT_STATE[pipelineEnd.event] ?? pipelineEnd.event : "running",
      // Paused by the dashboard: the step its Continue button runs.
      next: pipelineEnd?.event === "paused" && STEP_IDS.includes(pipelineEnd.next) ? pipelineEnd.next : undefined,
      note: pipelineEnd?.note,
    } : undefined,
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
    // For "Reuse, Refresh or Explore" in the start form, and whether the team shares them.
    snapshotInfo: (() => {
      const files = list(cwd, ".agentic-qa/snapshots", ".yml");
      const newest = files.reduce((t, f) => { try { return Math.max(t, fs.statSync(path.join(cwd, f)).mtimeMs); } catch { return t; } }, 0);
      return { count: files.length, newest: newest ? new Date(newest).toISOString() : undefined, requirements: fs.existsSync(path.join(cwd, ".agentic-qa/requirements/requirements.md")) };
    })(),
    share: list(cwd, ".agentic-qa/snapshots", ".yml").length ? snapshotShare(cwd) : undefined,
    // Agentic QA's own repository keeps its test runs out of git on purpose; don't ask to commit them there.
    selfRepo: (() => { try { return JSON.parse(fs.readFileSync(path.join(cwd, ".claude-plugin", "plugin.json"), "utf-8")).name === "agentic-qa"; } catch { return false; } })(),
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
    // For the story's status line (as in AIQA): criteria with at least one case, open questions, and tokens to date.
    acs: (() => {
      const ids = tcText ? criteriaList(sectionText(tcText, "Testable Acceptance Criteria")).map((c) => c.id) : [];
      const used = new Set((parsed?.table?.rows ?? []).flatMap((r) => String(r.cells.AC ?? "").split(/[,\s]+/)));
      return { total: ids.length, covered: ids.filter((id) => used.has(id)).length };
    })(),
    openQuestions: tcText ? questionList(tcText).filter((q) => !q.answered).length : 0,
    tokens: sumTokens(events.filter((e) => e.kind === "usage" && e.story === key)),
    feed: storyFeed(cwd, key),
  };
}

/** The latest progress lines, newest first: what each step did and when. */
function activity(events) {
  return events.filter((e) => e.step && e.event && e.ts).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).slice(-30).reverse()
    .map((e) => ({ ts: e.ts, kind: e.kind, story: e.story, step: e.step, event: e.event, note: e.note, target: e.target, next: e.next }));
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

/**
 * The Runs page (as in AIQA): one row per run, newest first, from progress.jsonl. A full-suite run groups its steps by
 * run id; a story's run groups its steps by story and run id. Each row has its steps, when it started, how long its
 * steps took, the tokens its dashboard sessions used and its result (a failed step, the tests' totals, or done).
 */
export function runsHistory(cwd, events = readProgress(cwd)) {
  const rows = new Map();
  const ms = (ts) => Date.parse(ts) || 0;
  for (const e of events) {
    if (!e.ts || !e.run || (e.kind !== "suite" && e.kind !== "story")) continue;
    const id = e.kind === "suite" ? `suite:${e.run}` : `story:${e.story}:${e.run}`;
    const r = rows.get(id) ?? { kind: e.kind, key: e.kind === "suite" ? "Full suite" : e.story, run: e.run, startedAt: e.ts, endedAt: e.ts, steps: new Map(), events: [] };
    if (ms(e.ts) < ms(r.startedAt)) r.startedAt = e.ts;
    if (ms(e.ts) > ms(r.endedAt)) r.endedAt = e.ts;
    r.events.push(e);
    if (e.step === "pipeline") {
      if (e.event === "start") { r.target = e.target; r.filter = e.filter; }
      r.state = EVENT_STATE[e.event] ?? e.event;
    } else {
      const s = r.steps.get(e.step) ?? { id: e.step };
      if (e.event === "start") { s.startedAt = e.ts; delete s.endedAt; delete s.note; }
      else s.endedAt = e.ts;
      s.status = EVENT_STATE[e.event] ?? e.event;
      if (e.note) s.note = e.note;
      if (s.startedAt && s.endedAt) s.durationMs = ms(s.endedAt) - ms(s.startedAt);
      r.steps.set(e.step, s);
    }
    rows.set(id, r);
  }
  const usage = events.filter((e) => e.kind === "usage");
  const names = Object.fromEntries([...SUITE_STEPS.map((s) => [s.id, s.name]), ...Object.entries(STORY_STEP_META).map(([id, m]) => [id, m.name])]);
  const storyRuns = {};
  const out = [...rows.values()].map((r) => {
    const order = [...SUITE_STEPS.map((s) => s.id), ...STORY_STEPS];
    const steps = [...r.steps.values()].map((s) => ({ ...s, name: names[s.id] ?? s.id })).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    // Tokens: a suite step's sessions are recorded with its run id; a story's dashboard session has its own run id,
    // so its usage counts toward the story run it overlaps.
    const toks = r.kind === "suite"
      ? usage.filter((u) => u.run === r.run && !u.story)
      : usage.filter((u) => u.story === r.key && ms(u.ts) >= ms(r.startedAt) && ms(u.ts) <= ms(r.endedAt) + 120_000);
    const failed = steps.find((s) => s.status === "failed");
    const running = steps.find((s) => s.status === "running");
    let result;
    if (failed) result = { kind: "failed", text: `${failed.name}: ${failed.note ?? "didn't finish"}` };
    else if (running) result = { kind: "running", text: `${running.name} is running` };
    else if (r.kind === "story" && steps.some((s) => s.id === "story-run" && s.status === "done")) {
      let tests;
      try {
        const sp = qaPaths(cwd);
        storyRuns[r.key] ??= runRows(fs.readFileSync(storyFiles(sp, r.key).testCaseFile, "utf-8"));
        tests = storyRuns[r.key].find((x) => x.run === r.run);
      } catch {}
      result = tests ? { kind: tests.failed ? "failed" : "passed", text: `${tests.passed} passed · ${tests.failed} failed${tests.skipped ? ` · ${tests.skipped} skipped` : ""}`, tests } : { kind: "passed", text: "Done" };
    } else if (r.kind === "suite" && r.state === "paused") result = { kind: "paused", text: "Waiting for you" };
    else result = { kind: "passed", text: steps.length ? "Done" : "Started" };
    return {
      kind: r.kind, key: r.key, run: r.run, target: r.target, filter: r.filter,
      // "Took": the time its steps ran, not the time it waited for a person's review between them.
      startedAt: r.startedAt, endedAt: r.endedAt, durationMs: steps.reduce((a, s) => a + (s.durationMs || 0), 0),
      steps: steps.filter((s) => s.status !== "skipped" || r.kind === "suite").map(({ id, name, status, durationMs, note }) => ({ id, name, status, durationMs, note })),
      ai: steps.some((s) => s.id !== "story-run" && s.id !== "story-pull" && s.status !== "skipped"),
      tokens: sumTokens(toks),
      result,
    };
  });
  return out.sort((a, b) => ms(b.startedAt) - ms(a.startedAt)).slice(0, 200);
}

/** Everything the dashboard shows on its main views. */
export function buildState(cwd) {
  const events = readProgress(cwd);
  const keys = storyKeys(cwd);
  const cases = testCaseIndex(cwd);
  return {
    project: path.basename(cwd),
    generatedAt: new Date().toISOString(),
    hasData: fs.existsSync(path.join(cwd, ".agentic-qa")),
    suite: suiteState(cwd, events, keys, cases),
    stories: keys.map((k) => storySummary(cwd, k, events)),
    activity: activity(events),
    // The project's app URL (Settings → Project), for the start form and a story's next step.
    workspace: { appUrl: typeof readWorkspace(cwd).appUrl === "string" ? readWorkspace(cwd).appUrl : "" },
    // The jump box (Ctrl/⌘K) searches these: every test case, by ID and title.
    cases: Object.values(cases).map((c) => ({ id: c.id, title: String(c.title ?? "").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"'), story: c.story, file: c.file })),
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
    questions: tc ? questionList(tc).map((q) => ({ id: q.id, html: inline(q.text), answered: q.answered })) : [],
    notesHtml: html(notes),
    historyHtml: html(sectionText(tc, "Run History")),
    headers: parsed?.table?.headers ?? [],
    rows: parsed?.table?.rows.map((r) => ({ cells: r.cells, html: Object.fromEntries(parsed.table.headers.map((h) => [h, inline((r.cells[h] ?? "").replace(/\\\|/g, "|"))])) })) ?? [],
    snapshots: list(cwd, posix(path.relative(cwd, files.snapshotsDir)), ".yml"),
    results: summarizeResults(cwd, resultsRel, testCaseIndex(cwd)),
    htmlReport: fileInfo(cwd, posix(path.relative(cwd, path.join(files.reportDir, "index.html")))),
  };
}
