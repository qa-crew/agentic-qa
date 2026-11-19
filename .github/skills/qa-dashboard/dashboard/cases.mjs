// Edits one story's test cases from the dashboard's story page (POST api/story/case): update a case's cells, add a
// case, or delete one; and records a manual result from the testing guide (POST api/story/manual). Only the cells a person reviews are editable; the rest of the file is kept as it is.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  escapeCell, findTestCaseTable, hasSource, parseFrontMatter, qaPaths, setFrontMatterValue, splitRow, storyFiles, tcPrefix,
  TC_STATUSES, updateTestCaseRows,
} from "../../qa-story/scripts/qa-files.mjs";
import { questionList } from "./read.mjs";

export const EDITABLE = ["AC", "Title", "Preconditions", "Steps", "Expected", "Tags", "Status"];
/** A case imported from an existing test follows that test: only these may change (see story-designer.md). */
const SOURCED_EDITABLE = ["AC", "Tags", "Status"];
const SOURCED_STATUSES = ["Existing", "Outdated", "Obsolete"];
export const CASE_TYPES = { S: "Smoke", R: "Regression", N: "Negative", E: "Edge" };
const MAX_CELL = 4000;

/** A cell's text for comparing what the form saw with the file: line breaks, numbering and "—" don't count. */
function sameText(v) {
  return String(v ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/\\\|/g, "|").split(/\r?\n/)
    .map((l) => l.trim().replace(/^\d+[.)]\s*/, "")).filter((l) => l && l !== "—").join("\n");
}

/** The form's cells, checked: known columns, text, a known status; steps numbered one per line. */
function cleanCells(raw, allowed) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "Send the test case's cells.";
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!EDITABLE.includes(k)) return `"${k}" can't be edited here.`;
    if (!allowed.includes(k)) return `"${k}" follows the existing test this case came from, so change it there.`;
    if (typeof v !== "string") return `"${k}" must be text.`;
    if (v.length > MAX_CELL) return `"${k}" is too long (${MAX_CELL} characters at most).`;
    out[k] = v.trim();
  }
  if (out.Status !== undefined) {
    const known = TC_STATUSES.find((s) => s.toLowerCase() === out.Status.toLowerCase());
    if (!known) return `Status must be one of: ${TC_STATUSES.join(", ")}.`;
    out.Status = known;
  }
  if (out.Steps !== undefined) {
    out.Steps = out.Steps.split(/\r?\n/).map((l) => l.trim().replace(/^\d+[.)]\s*/, "")).filter(Boolean).map((l, i) => `${i + 1}. ${l}`).join("\n");
  }
  if (out.Tags !== undefined) out.Tags = out.Tags.split(/\s+/).filter(Boolean).join(" ");
  return out;
}

const fail = (status, error) => ({ status, error });

/**
 * Tick an open question as answered, or untick it (POST api/story/question { id, answered }). The ticks are kept in
 * the test-case file's front matter, "answered: <id>, <id>", so Design keeps them and both products read them.
 */
export function answerQuestion(root, key, body) {
  const b = body && typeof body === "object" ? body : {};
  if (typeof b.answered !== "boolean") return fail(400, "answered must be true or false.");
  const file = storyFiles(qaPaths(root), key).testCaseFile;
  let text;
  try { text = fs.readFileSync(file, "utf-8"); } catch { return fail(404, `${key} has no test-case file yet.`); }
  const qs = questionList(text);
  if (!qs.some((q) => q.id === b.id)) return fail(404, "That question isn't in the test-case file any more. Reload the page.");
  const ids = new Set(qs.filter((q) => q.answered).map((q) => q.id));
  if (b.answered) ids.add(b.id); else ids.delete(b.id);
  // Keep only ids of questions that are still there.
  const keep = qs.map((q) => q.id).filter((id) => ids.has(id));
  fs.writeFileSync(file, setFrontMatterValue(text, "answered", keep.join(", ")), "utf-8");
  return { status: 200 };
}

const MANUAL = { passed: "✅ Passed (manual)", failed: "❌ Failed (manual)", blocked: "⛔ Blocked (manual)" };
const MAX_SHOT = 5 * 1024 * 1024;
/** A pasted screenshot's type from its first bytes, so a file that only claims to be an image is refused. */
function imageType(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  return undefined;
}

/**
 * The manual testing guide's save (POST api/story/manual): a person's result for one case, written like a test run's.
 * body: { id, outcome: "passed" | "failed" | "blocked", note?, base (the case's cells as the card showed them),
 * shot?: { data: base64 PNG or JPEG } }. Last Result becomes "❌ Failed (manual) · <date> · <note>"; a screenshot goes to
 * .agentic-qa/evidence/<KEY>/manual-<stamp>/<ID>.<png|jpg> and Evidence links to it. Manual results don't add a Run
 * History row: that table counts automated runs.
 */
export function recordManual(root, key, body) {
  const b = body && typeof body === "object" ? body : {};
  if (!(b.outcome in MANUAL)) return fail(400, 'outcome must be "passed", "failed" or "blocked".');
  if (b.note !== undefined && (typeof b.note !== "string" || b.note.length > 2000)) return fail(400, "The note must be text, 2000 characters at most.");
  let shot;
  if (b.shot !== undefined && b.shot !== null) {
    if (typeof b.shot !== "object" || typeof b.shot.data !== "string") return fail(400, "Send the screenshot as { data: <base64> }.");
    shot = Buffer.from(b.shot.data, "base64");
    if (shot.length > MAX_SHOT) return fail(413, "The screenshot is over 5 MB.");
    if (!imageType(shot)) return fail(400, "The screenshot must be a PNG or JPEG image.");
  }
  const sp = qaPaths(root);
  const file = storyFiles(sp, key).testCaseFile;
  let text;
  try { text = fs.readFileSync(file, "utf-8"); } catch { return fail(404, `${key} has no test-case file yet.`); }
  const table = findTestCaseTable(text.split(/\r?\n/));
  const row = table?.rows.find((r) => r.cells.ID === b.id)?.cells;
  if (typeof b.id !== "string" || !row) return fail(404, `There's no test case ${b.id ?? ""} in the file.`);
  if (!b.base || typeof b.base !== "object" || ["Title", "Steps", "Expected"].some((k) => k in row && sameText(b.base[k]) !== sameText(row[k]))) {
    return fail(409, `${b.id} changed in the file since the card opened. Reload it, then record the result.`);
  }
  const date = new Date().toISOString().slice(0, 10);
  const note = String(b.note ?? "").replace(/\s+/g, " ").trim();
  const patch = { "Last Result": `${MANUAL[b.outcome]} · ${date}${note ? ` · ${note}` : ""}` };
  if (shot) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    const dir = path.join(sp.evidenceDir, key, `manual-${stamp}`);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${b.id}.${imageType(shot)}`);
    fs.writeFileSync(dest, shot);
    patch.Evidence = `[screenshot](${path.relative(path.dirname(file), dest).replace(/\\/g, "/")})`;
  }
  fs.writeFileSync(file, updateTestCaseRows(text, { [b.id]: patch }, ["Last Result", "Evidence"]).text, "utf-8");
  return { status: 200, id: b.id };
}

/**
 * body: { action: "update" | "add" | "delete", id?, type? (S, R, N or E; add only), base? (the cells the form opened
 * with), cells? }. Returns { status, id? } or { status, error }.
 */
export function editCase(root, key, body) {
  const b = body && typeof body === "object" ? body : {};
  const file = storyFiles(qaPaths(root), key).testCaseFile;
  let text;
  try { text = fs.readFileSync(file, "utf-8"); } catch { return fail(404, `${key} has no test-case file yet. The Design step writes it.`); }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const table = findTestCaseTable(lines);
  if (!table) return fail(409, "The test-case file has no test-case table (with ID and Status columns) to edit.");
  const write = (next) => fs.writeFileSync(file, next, "utf-8");

  if (b.action === "add") {
    if (!(b.type in CASE_TYPES)) return fail(400, `Pick a type: ${Object.entries(CASE_TYPES).map(([k, v]) => `${k} (${v})`).join(", ")}.`);
    const cells = cleanCells(b.cells, EDITABLE);
    if (typeof cells === "string") return fail(400, cells);
    if (!cells.Title) return fail(400, "A test case needs a title.");
    // The next number of that type, after every ID in the table and every retired one (never reused).
    const prefix = `${tcPrefix(key)}${b.type}-`;
    const retired = String(parseFrontMatter(text).data.retired ?? "").split(/[\s,]+/).filter(Boolean);
    const used = [...table.rows.map((r) => r.cells.ID), ...retired].filter((id) => id.startsWith(prefix)).map((id) => Number(id.slice(prefix.length)) || 0);
    const id = `${prefix}${String(Math.max(0, ...used) + 1).padStart(3, "0")}`;
    const row = { Status: "Draft", ...cells, ID: id };
    const line = `| ${table.headers.map((h) => escapeCell(row[h] ?? "")).join(" | ")} |`;
    lines.splice(table.endLine + 1, 0, line);
    write(lines.join(eol));
    return { status: 200, id };
  }

  const idx = table.rows.findIndex((r) => r.cells.ID === b.id);
  if (typeof b.id !== "string" || idx < 0) return fail(404, `There's no test case ${b.id ?? ""} in the file.`);
  const row = table.rows[idx].cells;
  const sourced = hasSource(row.Source);
  // Someone (an agent, an editor) changed the row since the form opened: don't overwrite their change.
  if (!b.base || typeof b.base !== "object" || EDITABLE.some((k) => k in row && sameText(b.base[k]) !== sameText(row[k]))) {
    return fail(409, `${b.id} changed in the file since you opened it. Reload to see the change, then edit again.`);
  }

  if (b.action === "delete") {
    if (sourced) return fail(400, `${b.id} came from an existing test. Set its Status to Obsolete instead of deleting it.`);
    const lineNo = lines.findIndex((l, j) => j > table.startLine + 1 && j <= table.endLine && splitRow(l)[table.headers.indexOf("ID")] === b.id);
    if (lineNo < 0) return fail(404, `There's no test case ${b.id} in the file.`);
    lines.splice(lineNo, 1);
    // Deleted IDs are listed under "retired", so Design never brings the case back or reuses its ID.
    const retired = String(parseFrontMatter(text).data.retired ?? "").split(/[\s,]+/).filter(Boolean);
    write(setFrontMatterValue(lines.join(eol), "retired", [...new Set([...retired, b.id])].join(", ")));
    return { status: 200, id: b.id };
  }

  if (b.action === "update") {
    const cells = cleanCells(b.cells, sourced ? SOURCED_EDITABLE : EDITABLE);
    if (typeof cells === "string") return fail(400, cells);
    if (sourced && cells.Status && !SOURCED_STATUSES.includes(cells.Status)) return fail(400, `A case from an existing test is ${SOURCED_STATUSES.join(", ")}.`);
    if ("Title" in cells && !cells.Title) return fail(400, "A test case needs a title.");
    const patch = {};
    for (const [k, v] of Object.entries(cells)) if (k in row) patch[k] = v; // written through escapeCell
    write(updateTestCaseRows(text, { [b.id]: patch }).text);
    return { status: 200, id: b.id };
  }
  return fail(400, 'action must be "update", "add" or "delete".');
}
