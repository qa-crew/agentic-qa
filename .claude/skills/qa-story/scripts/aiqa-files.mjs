// AIQA's file formats, ported from @agents-forge/aiqa 2.5 (src/testcases/table.ts, src/stories/*.ts,
// src/alm/util.ts, src/results/*.ts) so the files these agents write stay readable by the npm package.
// No dependencies. Used by story.mjs and by the qa-dashboard skill.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Keys, tags, ids ─────────────────────────────────────────────────────────

export const STORY_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/;
export const isTagSafeKey = (key) => STORY_KEY_PATTERN.test(key);
export const storyTag = (key) => `@${key}`;
export const tcPrefix = (key) => `TC-${key.replace(/-/g, "")}-`;
export const storyGrep = (key) => `${storyTag(key)}\\b`;

export function extractTcId(s) {
  return s.match(/TC-[A-Za-z0-9]+-[A-Za-z]-\d+/)?.[0];
}

/** Text that mentions the story tag as a whole token. */
export function mentionsStoryTag(text, key) {
  const escaped = storyTag(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}(?![A-Za-z0-9-])`).test(text);
}

// ─── Front matter ────────────────────────────────────────────────────────────

export function parseFrontMatter(text) {
  const normalized = text.replace(/^﻿/, "");
  const m = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: normalized };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value.startsWith('"')) {
      try { value = JSON.parse(value); } catch { value = value.replace(/^"|"$/g, ""); }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    data[kv[1]] = value;
  }
  return { data, body: normalized.slice(m[0].length) };
}

export function stringifyFrontMatter(data) {
  const lines = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => {
      const s = String(v);
      return `${k}: ${/^[\w./@+-][\w ./@+()-]*$/.test(s) && !/:\s/.test(s) ? s : JSON.stringify(s)}`;
    });
  return `---\n${lines.join("\n")}\n---\n`;
}

export function setFrontMatterValue(text, key, value) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const { data, body } = parseFrontMatter(text);
  const fm = stringifyFrontMatter({ ...data, [key]: value }).replace(/\n/g, eol);
  return Object.keys(data).length || value ? fm + body : body;
}

// ─── Story files ─────────────────────────────────────────────────────────────

const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+/;
const indentOf = (l) => l.length - l.trimStart().length;

function parseCriteriaList(lines, from = 0, opts = {}) {
  const groups = [];
  let base = -1;
  let gap = false;
  let i = from;
  for (; i < lines.length; i++) {
    const raw = lines[i].replace(/\t/g, "    ").trimEnd();
    const t = raw.trim();
    if (!t) { gap = groups.length > 0; continue; }
    if (/^#{1,6}\s/.test(t) || (/^\*\*[^*]+\*\*:?$/.test(t) && groups.length)) break;
    const item = raw.match(LIST_ITEM);
    const ind = indentOf(raw);
    if (item && (base === -1 || ind <= base)) {
      base = base === -1 ? ind : base;
      groups.push([raw.slice(item[0].length).trim()]);
    } else if (base === -1) {
      if (!opts.listOnly) groups.push([t]);
    } else if (ind > base || !gap || t.startsWith("|")) {
      groups[groups.length - 1].push(raw);
    } else break;
    gap = false;
  }
  const items = groups.map(([first, ...rest]) => {
    const cut = rest.length ? Math.min(...rest.map(indentOf)) : 0;
    return [first, ...rest.map((l) => l.slice(cut))].join("\n");
  });
  return { items, end: i };
}

function splitAcceptanceCriteria(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /acceptance\s+criteria/i.test(l) && /^(#{1,6}\s|\*\*|__|[A-Za-z ]+:\s*$)/.test(l.trim()));
  if (start !== -1) {
    const { items, end } = parseCriteriaList(lines, start + 1);
    if (items.length) {
      const description = [...lines.slice(0, start), ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n").trim();
      return { description, criteria: items };
    }
  }
  const criteria = [];
  for (const l of lines) {
    const t = l.trim().replace(LIST_ITEM, "");
    if (/^(given|scenario)\b/i.test(t)) criteria.push(t);
  }
  return { description: markdown, criteria };
}

function section(body, name) {
  const lines = body.split(/\r?\n/);
  const i = lines.findIndex((l) => new RegExp(`^##\\s+${name}\\s*$`, "i").test(l.trim()));
  if (i === -1) return undefined;
  const out = [];
  for (let j = i + 1; j < lines.length && !/^##\s/.test(lines[j]); j++) out.push(lines[j]);
  return out.join("\n").trim();
}

export function keyFromFileName(file) {
  const base = path.basename(file, path.extname(file));
  return base.match(/^([A-Za-z][A-Za-z0-9]*-\d+|[A-Za-z]+\d+)(?=$|-)/)?.[1];
}

/** A story file → { key, title, description, acceptanceCriteria }, or undefined without a key. */
export function parseStoryFile(text, file) {
  const { data, body } = parseFrontMatter(text);
  const key = data.key || keyFromFileName(file);
  if (!key) return undefined;
  const titleLine = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const title = data.title || titleLine?.replace(new RegExp(`^${key.replace(/[-]/g, "\\-")}\\s*[—–:-]\\s*`), "") || key;
  let description = section(body, "Description");
  if (description === undefined) description = body.replace(/^#\s+.+$/m, "").replace(/^>.*$/gm, "").trim();
  const acSection = section(body, "Acceptance Criteria");
  let acceptanceCriteria;
  if (acSection !== undefined) acceptanceCriteria = parseCriteriaList(acSection.split(/\r?\n/), 0, { listOnly: true }).items;
  else ({ description, criteria: acceptanceCriteria } = splitAcceptanceCriteria(description));
  return { key, title, description: description.replace(/^_No description\._$/, ""), acceptanceCriteria };
}

/** The same 12-character hash AIQA writes as `storyHash`. */
export function storyHash(item) {
  const h = createHash("sha1");
  h.update(item.title.trim());
  h.update("\u0000");
  h.update(item.description.trim());
  h.update("\u0000");
  h.update(item.acceptanceCriteria.map((a) => a.trim()).join("\n"));
  return h.digest("hex").slice(0, 12);
}

const SLUG_STOPWORDS = new Set(
  "a an the and or but to of for with without in on at by from into as is are be can should will must i we you my our their this that it its so when then user users".split(" ")
);

export function storySlug(title, maxWords = 3, maxLen = 30) {
  let t = title.normalize("NFKD").replace(/[̀-ͯ]/g, "").trim();
  t = t.replace(/^as an?\s+[^,]+?,?\s+i\s+(?:want|need|would like)\s+(?:to\s+)?/i, "");
  const label = t.match(/^([^:—–]{2,40}?)\s*(?::|\s[—–-]\s)/)?.[1];
  if (label && label.trim().split(/\s+/).length <= 4) t = label;
  const words = t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const meaningful = words.filter((w) => !SLUG_STOPWORDS.has(w));
  let slug = "";
  for (const w of (meaningful.length ? meaningful : words).slice(0, maxWords)) {
    const next = slug ? `${slug}-${w}` : w;
    if (next.length > maxLen) break;
    slug = next;
  }
  return slug || words[0]?.slice(0, maxLen) || "story";
}

// ─── Paths ───────────────────────────────────────────────────────────────────

export function aiqaPaths(cwd = process.cwd()) {
  const base = path.join(cwd, ".aiqa");
  const specsDir = path.join(base, "test-scripts");
  const reportsDir = path.join(base, "reports");
  return {
    cwd,
    base,
    storiesDir: path.join(base, "stories"),
    indexFile: path.join(base, "stories", "index.json"),
    testCasesDir: path.join(base, "test-cases"),
    specsDir,
    pagesDir: path.join(specsDir, "pages"),
    snapshotsDir: path.join(base, "snapshots"),
    evidenceDir: path.join(base, "evidence"),
    reportsDir,
    storyReportsDir: path.join(reportsDir, "stories"),
    authState: path.join(base, "auth-state.json"),
    playwrightConfig: path.join(base, "playwright.stories.config.ts"),
    progressFile: path.join(base, "progress.jsonl"),
  };
}

function findByPrefix(dir, key, ext) {
  if (!fs.existsSync(dir)) return undefined;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(ext) && (f === `${key}${ext}` || f.startsWith(`${key}-`))).sort();
  return files[0] ? path.join(dir, files[0]) : undefined;
}

/** Every per-story file shares the story file's base name (SD-1-login.md → SD-1-login.spec.ts). */
export function storyFiles(sp, key, title = key) {
  const existingStory = findByPrefix(sp.storiesDir, key, ".md");
  const baseName = existingStory ? path.basename(existingStory, ".md") : `${key}-${storySlug(title)}`;
  return {
    storyFile: existingStory ?? path.join(sp.storiesDir, `${baseName}.md`),
    testCaseFile: findByPrefix(sp.testCasesDir, key, ".md") ?? path.join(sp.testCasesDir, `${baseName}.md`),
    specFile: findByPrefix(sp.specsDir, key, ".spec.ts") ?? path.join(sp.specsDir, `${baseName}.spec.ts`),
    snapshotsDir: path.join(sp.snapshotsDir, key),
    evidenceDir: path.join(sp.evidenceDir, key),
    resultsFile: path.join(sp.storyReportsDir, key, "results.json"),
    reportDir: path.join(sp.storyReportsDir, key, "html"),
    outputDir: path.join(sp.storyReportsDir, key, "artifacts"),
  };
}

// ─── The test-case table ─────────────────────────────────────────────────────

export const TC_STATUSES = ["Draft", "Verified", "Updated", "New", "Blocked", "Possible defect", "Existing", "Outdated", "Obsolete"];
export const SCRIPTABLE_STATUSES = ["Verified", "Updated", "New"];

export function hasSource(cell) {
  return !!cell && !/^[—–-]?$/.test(cell.trim());
}

export function parseSource(cell) {
  const m = (cell ?? "").trim().match(/^(spec|alm|csv)\s*:\s*(.+)$/i);
  if (!m) return undefined;
  return { kind: m[1].toLowerCase(), label: m[2].replace(/\\\|/g, "|").trim() };
}

const HEADER_ALIASES = {
  id: "ID", "tc id": "ID", "test id": "ID",
  ac: "AC", "acceptance criteria": "AC",
  title: "Title", name: "Title",
  preconditions: "Preconditions", precondition: "Preconditions",
  steps: "Steps",
  expected: "Expected", "expected result": "Expected", "expected results": "Expected",
  tags: "Tags",
  status: "Status",
  "last result": "Last Result", result: "Last Result",
  evidence: "Evidence", screenshot: "Evidence",
  alm: "ALM", "alm id": "ALM",
  source: "Source",
};

const canonicalColumn = (header) => HEADER_ALIASES[header.trim().toLowerCase()] ?? header.trim();

/** Split one markdown table row into cells, honouring escaped pipes. */
export function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") { cur += "\\|"; i++; continue; }
    if (ch === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

export function escapeCell(value) {
  return value.replace(/\r?\n/g, "<br>").replace(/(?<!\\)\|/g, "\\|").trim() || "—";
}

const isSeparator = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

/** The first markdown table whose header has an ID and a Status column. */
export function findTestCaseTable(lines) {
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith("|") || !isSeparator(lines[i + 1])) continue;
    const headers = splitRow(lines[i]).map(canonicalColumn);
    if (!headers.includes("ID") || !headers.includes("Status")) continue;
    const rows = [];
    let j = i + 2;
    for (; j < lines.length && lines[j].trim().startsWith("|"); j++) {
      const values = splitRow(lines[j]);
      const cells = {};
      headers.forEach((h, k) => { cells[h] = values[k] ?? ""; });
      if (cells.ID) rows.push({ cells });
    }
    return { headers, rows, startLine: i, endLine: j - 1 };
  }
  return undefined;
}

export function parseTestCaseFile(text) {
  return { frontMatter: parseFrontMatter(text).data, table: findTestCaseTable(text.split(/\r?\n/)) };
}

const renderRow = (headers, cells) => `| ${headers.map((h) => escapeCell(cells[h] ?? "")).join(" | ")} |`;

/** Update cells of rows matched by ID; everything else in the file stays as it is. */
export function updateTestCaseRows(text, updates, ensureColumns = []) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const table = findTestCaseTable(lines);
  if (!table) return { text, updated: [] };
  const headers = [...table.headers];
  for (const col of ensureColumns) if (!headers.includes(col)) headers.push(col);
  const headersChanged = headers.length !== table.headers.length;
  const updated = [];
  const out = [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`];
  for (let j = table.startLine + 2; j <= table.endLine; j++) {
    const values = splitRow(lines[j]);
    const cells = {};
    table.headers.forEach((h, k) => { cells[h] = values[k] ?? ""; });
    const patch = cells.ID ? updates[cells.ID] : undefined;
    if (!patch && !headersChanged) { out.push(lines[j]); continue; }
    if (patch) {
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) cells[k] = v;
      updated.push(cells.ID);
    }
    out.push(renderRow(headers, cells));
  }
  return { text: [...lines.slice(0, table.startLine), ...out, ...lines.slice(table.endLine + 1)].join(eol), updated };
}

/** Append a row to the table under `## <heading>`, creating the section at the end when missing. */
export function appendToSectionTable(text, heading, header, row) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const rowLine = `| ${row.map(escapeCell).join(" | ")} |`;
  const idx = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (idx === -1) {
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("", `## ${heading}`, "", `| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, rowLine, "");
    return lines.join(eol);
  }
  let insertAt = -1;
  for (let j = idx + 1; j < lines.length && !/^#{1,2}\s/.test(lines[j]); j++) {
    if (lines[j].trim().startsWith("|")) insertAt = j;
  }
  if (insertAt === -1) lines.splice(idx + 1, 0, "", `| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, rowLine);
  else lines.splice(insertAt + 1, 0, rowLine);
  return lines.join(eol);
}

export function statusCounts(table) {
  const counts = {};
  for (const r of table?.rows ?? []) {
    const raw = (r.cells.Status ?? "").trim();
    const known = TC_STATUSES.find((s) => s.toLowerCase() === raw.toLowerCase());
    const k = known ?? (raw || "Unknown");
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

// ─── Where a story stands (src/stories/stage.ts) ─────────────────────────────

export const STORY_STEPS = ["story-pull", "story-design", "story-explore", "story-script", "story-run"];

const listYml = (dir) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith(".yml")); } catch { return []; } };
const readCases = (file) => { try { return parseTestCaseFile(fs.readFileSync(file, "utf-8")); } catch { return undefined; } };

export function scriptableRows(parsed) {
  const wanted = [...SCRIPTABLE_STATUSES, "Possible defect"].map((s) => s.toLowerCase());
  return (parsed?.table?.rows ?? [])
    .filter((r) => !hasSource(r.cells.Source) && wanted.includes((r.cells.Status ?? "").trim().toLowerCase()))
    .map((r) => r.cells.ID);
}

export function nothingToAutomate(parsed) {
  const rows = parsed?.table?.rows ?? [];
  if (!rows.length || scriptableRows(parsed).length) return undefined;
  if (rows.every((r) => hasSource(r.cells.Source))) return "Every case comes from an existing test, so there's nothing for Agentic QA to automate";
  return "No case is ready to automate (none is Verified, Updated, New or a possible defect)";
}

export function stepDone(step, files, key, runStart) {
  switch (step) {
    case "story-pull":
      return fs.existsSync(files.storyFile);
    case "story-design": {
      const parsed = readCases(files.testCaseFile);
      const rows = parsed?.table?.rows ?? [];
      return rows.length > 0 && (!!parsed.frontMatter.storyHash || rows.some((r) => !hasSource(r.cells.Source)));
    }
    case "story-explore": {
      if (!listYml(files.snapshotsDir).length) return false;
      const parsed = readCases(files.testCaseFile);
      return !!parsed?.table?.rows.length && !statusCounts(parsed.table).Draft;
    }
    case "story-script":
      try { return mentionsStoryTag(fs.readFileSync(files.specFile, "utf-8"), key); } catch { return false; }
    case "story-run":
      try { return runStart === undefined ? fs.existsSync(files.resultsFile) : fs.statSync(files.resultsFile).mtimeMs >= runStart; } catch { return false; }
  }
  return false;
}

export function stepState(sp, key, title = key) {
  const files = storyFiles(sp, key, title);
  const done = Object.fromEntries(STORY_STEPS.map((s) => [s, stepDone(s, files, key)]));
  const notNeeded = {};
  if (done["story-explore"] && !done["story-script"]) {
    const why = nothingToAutomate(readCases(files.testCaseFile));
    if (why) {
      notNeeded["story-script"] = why;
      done["story-script"] = true;
      if (!done["story-run"]) {
        notNeeded["story-run"] = "Nothing to run: Agentic QA has no spec for this story";
        done["story-run"] = true;
      }
    }
  }
  const i = STORY_STEPS.findIndex((s) => !done[s]);
  const next = i < 0 ? undefined : STORY_STEPS[i];
  const prev = i > 0 ? STORY_STEPS[i - 1] : undefined;
  return { done, notNeeded, next, review: !!next && done["story-design"] && (prev === "story-design" || prev === "story-explore") };
}

// ─── Results (src/results/apply.ts) ──────────────────────────────────────────

const ANSI = /\x1b\[[0-9;]*m/g;

function firstLine(s) {
  if (!s) return undefined;
  const line = s.replace(ANSI, "").split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return line ? (line.length > 160 ? line.slice(0, 157) + "…" : line) : undefined;
}

const RANK = { failed: 3, blocked: 3, flaky: 2, passed: 1, skipped: 0 };

/** A Playwright JSON report → one result per TC id (the worst outcome wins). */
export function parseResultsJson(report) {
  const byTc = new Map();
  const untraced = [];
  const walk = (suite, titles) => {
    for (const spec of suite?.specs ?? []) {
      const title = String(spec.title ?? "");
      const tcId = extractTcId(title) ?? extractTcId([...titles, title].join(" "));
      for (const test of spec.tests ?? []) {
        const results = test.results ?? [];
        const last = results[results.length - 1];
        let outcome;
        if (test.status === "flaky") outcome = "flaky";
        else if (test.status === "skipped" || last?.status === "skipped") outcome = "skipped";
        else if (test.status === "expected") outcome = "passed";
        else outcome = "failed";
        if (!tcId) { untraced.push(title); continue; }
        const shots = results.flatMap((r) => (r.attachments ?? []).filter((a) => a?.path && /^image\//.test(a.contentType ?? "")));
        const res = {
          tcId,
          title,
          outcome,
          durationMs: results.reduce((a, r) => a + (Number(r.duration) || 0), 0),
          error: outcome === "failed" ? firstLine(last?.error?.message ?? last?.errors?.[0]?.message) : undefined,
          screenshot: shots[shots.length - 1]?.path,
        };
        const prev = byTc.get(tcId);
        if (!prev || RANK[res.outcome] > RANK[prev.outcome]) byTc.set(tcId, res);
      }
    }
    for (const child of suite?.suites ?? []) walk(child, [...titles, String(child.title ?? "")]);
  };
  for (const s of report?.suites ?? []) walk(s, []);
  const results = [...byTc.values()];
  const count = (o) => results.filter((r) => r.outcome === o).length;
  return { results, untraced, stats: { passed: count("passed"), failed: count("failed"), skipped: count("skipped"), flaky: count("flaky") } };
}

const fmtSecs = (ms) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);

export function resultCell(r, date) {
  switch (r.outcome) {
    case "passed": return `✅ Passed · ${date} · ${fmtSecs(r.durationMs)}`;
    case "flaky": return `⚠️ Flaky (passed on retry) · ${date}`;
    case "skipped": return `⏭️ Skipped · ${date}`;
    case "blocked": return `⛔ Blocked · ${date}${r.error ? ` · ${r.error}` : ""}`;
    default: return `❌ Failed · ${date}${r.error ? ` · ${r.error}` : ""}`;
  }
}

/** Write a run's results into the test-case file: Last Result, Evidence (screenshot copy) and a Run History row. */
export function applyResults({ runId, testCaseFile, resultsFile, evidenceDir, reportLabel }) {
  const parsed = parseResultsJson(JSON.parse(fs.readFileSync(resultsFile, "utf-8")));
  const text = fs.readFileSync(testCaseFile, "utf-8");
  // Rows imported from existing tests never take a story run's results.
  const ids = new Set(parseTestCaseFile(text).table?.rows.filter((r) => !hasSource(r.cells.Source)).map((r) => r.cells.ID) ?? []);
  const date = new Date().toISOString().slice(0, 10);
  const runDir = path.join(evidenceDir, runId);
  const updates = {};
  let screenshots = 0;
  for (const r of parsed.results) {
    if (!ids.has(r.tcId)) continue;
    const patch = { "Last Result": resultCell(r, date) };
    if (r.screenshot && fs.existsSync(r.screenshot)) {
      fs.mkdirSync(runDir, { recursive: true });
      const dest = path.join(runDir, `${r.tcId}${path.extname(r.screenshot) || ".png"}`);
      fs.copyFileSync(r.screenshot, dest);
      screenshots++;
      patch.Evidence = `[screenshot](${path.relative(path.dirname(testCaseFile), dest).replace(/\\/g, "/")})`;
    }
    updates[r.tcId] = patch;
  }
  const next = updateTestCaseRows(text, updates, ["Last Result", "Evidence", "ALM"]);
  const s = parsed.stats;
  const withHistory = appendToSectionTable(
    next.text,
    "Run History",
    ["Run", "Date", "Passed", "Failed", "Flaky", "Skipped", "Report"],
    [runId, date, String(s.passed), String(s.failed), String(s.flaky), String(s.skipped), reportLabel ? `\`${reportLabel}\`` : "—"]
  );
  fs.writeFileSync(testCaseFile, withHistory, "utf-8");
  const ran = new Set(parsed.results.map((r) => r.tcId));
  return {
    parsed,
    updatedRows: next.updated,
    notRun: [...ids].filter((id) => !ran.has(id)),
    unknown: [...ran].filter((id) => !ids.has(id)),
    screenshots,
  };
}

// ─── The story Playwright config (src/results/run.ts) ────────────────────────

/**
 * The `testIdAttribute` the project's playwright.config.ts sets (e.g. "data-test"), or undefined. Story specs reuse
 * the suite's page objects, whose getByTestId() calls only work with the same attribute.
 */
export function suiteTestIdAttribute(cwd) {
  let text = "";
  try { text = fs.readFileSync(path.join(cwd, "playwright.config.ts"), "utf-8"); } catch { return undefined; }
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return code.match(/\btestIdAttribute\s*:\s*(["'`])([^"'`\s]+)\1/)?.[2];
}

export function storyPlaywrightConfig(sp, baseUrl, testIdAttribute) {
  const posix = (p) => p.replace(/\\/g, "/");
  const testId = testIdAttribute
    ? `    // The same element-id attribute as the project's playwright.config.ts, so shared page objects work.
    testIdAttribute: ${JSON.stringify(testIdAttribute)},
`
    : "";
  return `// Generated by @agents-forge/aiqa for the story workflow.
// It is rewritten before every story run, so put lasting changes in aiqa.config.ts instead.
// Run one story by hand:  npx playwright test -c ${posix(path.relative(sp.cwd, sp.playwrightConfig))} --grep "@<KEY>\\b"
import { defineConfig, devices } from "@playwright/test";

// Saved login (written by the Explore step when it signs in). Deliberately NOT applied to every
// test — login/logout stories must start signed out. Specs opt in with:
//   test.use({ storageState: process.env.AIQA_AUTH_STATE })
process.env.AIQA_AUTH_STATE ??= ${JSON.stringify(posix(sp.authState))};

export default defineConfig({
  testDir: "./test-scripts",
  outputDir: process.env.AIQA_STORY_OUTPUT || "./reports/stories/_artifacts",
  fullyParallel: true,
  retries: 0,
  reporter: [
    ["list"],
    ["json", { outputFile: process.env.AIQA_STORY_RESULTS || "./reports/stories/results.json" }],
    ["html", { outputFolder: process.env.AIQA_STORY_HTML || "./reports/stories/html", open: "never" }],
  ],
  use: {
    baseURL: process.env.BASE_URL || ${JSON.stringify(baseUrl)},
    // Every test gets a screenshot — AIQA copies it next to the test case as evidence.
    screenshot: "on",
    trace: "retain-on-failure",
${testId}  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
`;
}

export function writeStoryPlaywrightConfig(sp, baseUrl) {
  const content = storyPlaywrightConfig(sp, baseUrl, suiteTestIdAttribute(sp.cwd));
  fs.mkdirSync(path.dirname(sp.playwrightConfig), { recursive: true });
  const prev = fs.existsSync(sp.playwrightConfig) ? fs.readFileSync(sp.playwrightConfig, "utf-8") : "";
  if (prev !== content) fs.writeFileSync(sp.playwrightConfig, content, "utf-8");
  return sp.playwrightConfig;
}

// ─── Progress lines (read by the dashboard) ──────────────────────────────────

export function appendProgress(sp, entry) {
  fs.mkdirSync(path.dirname(sp.progressFile), { recursive: true });
  fs.appendFileSync(sp.progressFile, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf-8");
}

// ─── Models per role (src/ai/settings.ts) ────────────────────────────────────
// .aiqa/ai.json is shared with the npm package: { provider?, models?: { anthropic?: {...}, "copilot-sdk"?: {...} } }.

export const MODEL_ROLES = ["analyst", "qa-planner", "qa-engineer", "qa-reviewer", "qa-reporter"];
export const MODEL_KEYS = ["default", ...MODEL_ROLES];
/** The model aliases a subagent can be started with. */
export const MODEL_ALIASES = ["sonnet", "opus", "haiku", "fable"];
/** The role each story step's agent plays (the npm package's STEP_META). */
export const STORY_STEP_ROLE = { "story-design": "qa-planner", "story-explore": "analyst", "story-script": "qa-engineer" };
const PROVIDERS = ["anthropic", "copilot-sdk"];

function cleanId(v) {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s && s.length <= 120 && /^[\w.:/@[\]-]+$/.test(s) ? s : undefined;
}

function cleanRoleModels(m) {
  const out = {};
  if (!m || typeof m !== "object") return out;
  for (const k of MODEL_KEYS) {
    const id = cleanId(m[k]);
    if (id) out[k] = id;
  }
  return out;
}

export function cleanAiSettings(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const out = {};
  if (r.provider === "auto" || PROVIDERS.includes(r.provider)) out.provider = r.provider;
  const models = {};
  for (const p of PROVIDERS) {
    const m = cleanRoleModels(r.models?.[p]);
    if (Object.keys(m).length) models[p] = m;
  }
  if (Object.keys(models).length) out.models = models;
  return out;
}

export const aiSettingsFile = (cwd) => path.join(cwd, ".aiqa", "ai.json");

export function readAiSettings(cwd) {
  try { return cleanAiSettings(JSON.parse(fs.readFileSync(aiSettingsFile(cwd), "utf-8"))); } catch { return {}; }
}

/** Replace the Claude picks; everything else in ai.json (provider, Copilot picks) is kept. */
export function writeClaudeModels(cwd, picks) {
  const current = readAiSettings(cwd);
  const next = { ...current, models: { ...(current.models ?? {}), anthropic: cleanRoleModels(picks) } };
  if (!Object.keys(next.models.anthropic).length) delete next.models.anthropic;
  const clean = cleanAiSettings(next);
  fs.mkdirSync(path.dirname(aiSettingsFile(cwd)), { recursive: true });
  fs.writeFileSync(aiSettingsFile(cwd), JSON.stringify(clean, null, 2) + "\n");
  return clean;
}

/** "opus", "claude-opus-4-8", "sonnet[1m]" → the alias a subagent takes; undefined for anything else. */
export function modelAlias(id) {
  if (!id) return undefined;
  const s = id.toLowerCase();
  if (MODEL_ALIASES.includes(s)) return s;
  return MODEL_ALIASES.find((a) => s === `claude-${a}` || s.startsWith(`claude-${a}-`) || s.startsWith(`${a}[`));
}

/**
 * The model each role runs on, resolved like the npm package's resolveAi() + modelFor(): per key, the command line
 * (--model-<key>, else --model) wins over .aiqa/ai.json; a role without its own pick takes the default. Nothing
 * picked = null: the agent's `model: inherit`, i.e. the session's model.
 */
export function resolveRoleModels(cwd, flags = {}) {
  const saved = readAiSettings(cwd).models?.anthropic ?? {};
  const keys = {};
  for (const k of MODEL_KEYS) {
    const hit = [[flags.models?.[k] ?? flags.model, "command line"], [saved[k], ".aiqa/ai.json"]].find(([v]) => !!v);
    if (hit) keys[k] = hit;
  }
  const out = {};
  for (const role of MODEL_ROLES) {
    const [raw, source] = keys[role] ?? keys.default ?? [undefined, "session"];
    const alias = modelAlias(raw);
    out[role] = {
      model: alias ?? null,
      source,
      ...(raw && raw !== alias ? { raw } : {}),
      ...(raw && !alias ? { note: `"${raw}" isn't a Claude model an agent can be started with, so the session's model is used` } : {}),
    };
  }
  return out;
}

/** `--model <id>` and `--model-<role> <id>`; unknown roles are reported so a typo isn't silently ignored. */
export function parseModelFlags(args) {
  const models = {};
  const unknown = [];
  let model;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--model")) continue;
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    const value = eq === -1 ? (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined) : a.slice(eq + 1);
    if (name === "--model") { model = cleanId(value); continue; }
    const role = name.slice("--model-".length);
    if (name.startsWith("--model-") && MODEL_KEYS.includes(role)) {
      const id = cleanId(value);
      if (id) models[role] = id;
    } else unknown.push(name);
  }
  return { model, models, unknown };
}
