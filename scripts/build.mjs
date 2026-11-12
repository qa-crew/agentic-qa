#!/usr/bin/env node
// Builds everything that's generated from .claude/ (the one source):
//   - .claude-plugin/plugin.json `agents`: every .claude/agents/*.md (plugin agent paths must be listed file by file)
//   - .github/agents/<name>.agent.md: GitHub Copilot custom agents (same body, Copilot tool aliases)
//   - .github/skills/<name>/: a mirror of .claude/skills for Copilot, with ${CLAUDE_SKILL_DIR} spelled out
// It also checks the agents' and skills' frontmatter.
//   node scripts/build.mjs           write the generated files
//   node scripts/build.mjs --check   fail when anything generated is out of date (CI)
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");
const AGENTS_DIR = ".claude/agents";
const SKILLS_DIR = ".claude/skills";
const GH_AGENTS = ".github/agents";
const GH_SKILLS = ".github/skills";
const PLUGIN = ".claude-plugin/plugin.json";

// Claude Code tool → GitHub Copilot tool alias (docs.github.com, "custom agents configuration").
const COPILOT_TOOL = {
  Read: "read", Write: "edit", Edit: "edit", NotebookEdit: "edit", Glob: "search", Grep: "search",
  Bash: "execute", WebFetch: "web", WebSearch: "web", Task: "agent", Agent: "agent", TodoWrite: "todo",
};
const MODELS = /^(inherit|sonnet|opus|haiku|fable|claude-[a-z0-9.-]+)$/;
const COLORS = new Set(["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"]);

const errors = [];
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf-8").replace(/\r\n/g, "\n");

/** Flat `key: value` frontmatter. Values that YAML would misread must be quoted in the source. */
function frontmatter(text, file) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) { errors.push(`${file}: no frontmatter`); return { data: {}, body: text, raw: "" }; }
  const data = {};
  for (const line of m[1].split("\n")) {
    if (!line.trim()) continue;
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) { errors.push(`${file}: can't read frontmatter line "${line}"`); continue; }
    let v = kv[2].trim();
    if (v.startsWith('"')) {
      try { v = JSON.parse(v); } catch { errors.push(`${file}: bad quoted value for ${kv[1]}`); }
    } else if (/:\s|\s#/.test(v)) {
      errors.push(`${file}: "${kv[1]}" has ": " or " #" in it; put the value in double quotes`);
    }
    data[kv[1]] = v;
  }
  return { data, body: text.slice(m[0].length), raw: m[1] };
}

const generated = new Map(); // project-relative path → string | Buffer

// ── Agents ──────────────────────────────────────────────────────────────────
const agentFiles = fs.readdirSync(path.join(ROOT, AGENTS_DIR)).filter((f) => f.endsWith(".md")).sort();
const names = new Set();
for (const f of agentFiles) {
  const file = `${AGENTS_DIR}/${f}`;
  const { data, body } = frontmatter(read(file), file);
  const name = data.name;
  if (!name || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) errors.push(`${file}: name must be lowercase words joined by hyphens`);
  if (name && `${name}.md` !== f) errors.push(`${file}: the file name must be "${name}.md"`);
  if (names.has(name)) errors.push(`${file}: duplicate agent name "${name}"`);
  names.add(name);
  if (!data.description || data.description.length < 40) errors.push(`${file}: needs a description that says when to use the agent`);
  const tools = (data.tools ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (!tools.length) errors.push(`${file}: list its tools (least privilege)`);
  for (const t of tools) if (!(t in COPILOT_TOOL)) errors.push(`${file}: unknown tool "${t}"`);
  if (data.model && !MODELS.test(data.model)) errors.push(`${file}: unknown model "${data.model}"`);
  if (data.color && !COLORS.has(data.color)) errors.push(`${file}: unknown color "${data.color}"`);

  const copilotTools = [...new Set(tools.map((t) => COPILOT_TOOL[t]).filter(Boolean))];
  generated.set(
    `${GH_AGENTS}/${name}.agent.md`,
    `---\nname: ${name}\ndescription: ${JSON.stringify(data.description)}\ntools: [${copilotTools.map((t) => `'${t}'`).join(", ")}]\n---\n` +
      `<!-- Generated from ${file} by scripts/build.mjs. Edit that file, then run: npm run build -->\n` +
      body
  );
}

// ── Skills ──────────────────────────────────────────────────────────────────
const skillDirs = fs.readdirSync(path.join(ROOT, SKILLS_DIR), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
for (const name of skillDirs) {
  const dir = `${SKILLS_DIR}/${name}`;
  const skillFile = `${dir}/SKILL.md`;
  if (!fs.existsSync(path.join(ROOT, skillFile))) { errors.push(`${dir}: no SKILL.md`); continue; }
  const text = read(skillFile);
  const { data } = frontmatter(text, skillFile);
  if (data.name !== name) errors.push(`${skillFile}: name must match its folder ("${name}")`);
  if (!data.description) errors.push(`${skillFile}: needs a description`);
  for (const abs of walk(path.join(ROOT, dir))) {
    if (/__pycache__|\.DS_Store$/.test(abs)) continue;
    const r = rel(abs);
    const out = `${GH_SKILLS}/${r.slice(SKILLS_DIR.length + 1)}`;
    if (r === skillFile) {
      const mirrored = text.replaceAll("${CLAUDE_SKILL_DIR}", `${GH_SKILLS}/${name}`);
      const end = mirrored.indexOf("\n---\n", 4) + 5;
      generated.set(out, mirrored.slice(0, end) + `<!-- Generated from ${skillFile} by scripts/build.mjs. Edit that file, then run: npm run build -->\n` + mirrored.slice(end));
    } else {
      generated.set(out, fs.readFileSync(abs));
    }
  }
}

// ── Plugin manifest ─────────────────────────────────────────────────────────
const plugin = JSON.parse(read(PLUGIN));
plugin.agents = agentFiles.map((f) => `./${AGENTS_DIR}/${f}`);
generated.set(PLUGIN, JSON.stringify(plugin, null, 2) + "\n");
const market = JSON.parse(read(".claude-plugin/marketplace.json"));
for (const p of market.plugins ?? []) if (p.name === plugin.name && p.version && p.version !== plugin.version) errors.push(`marketplace.json: version ${p.version} ≠ plugin.json ${plugin.version}`);

if (errors.length) {
  console.error(`❌ ${errors.length} problem(s):\n` + errors.map((e) => `  - ${e}`).join("\n"));
  process.exit(1);
}

// ── Write or check ──────────────────────────────────────────────────────────
const same = (p, content) => {
  try {
    const disk = fs.readFileSync(path.join(ROOT, p));
    return Buffer.isBuffer(content) ? disk.equals(content) : disk.toString("utf-8").replace(/\r\n/g, "\n") === content;
  } catch {
    return false;
  }
};
const existing = [GH_AGENTS, GH_SKILLS].flatMap((d) => (fs.existsSync(path.join(ROOT, d)) ? walk(path.join(ROOT, d)).map(rel) : []));
const stale = [...generated].filter(([p, c]) => !same(p, c)).map(([p]) => p);
const extra = existing.filter((p) => !generated.has(p));

if (CHECK) {
  if (stale.length || extra.length) {
    console.error("❌ Generated files are out of date. Run: npm run build");
    for (const p of stale) console.error(`  changed: ${p}`);
    for (const p of extra) console.error(`  not generated (remove): ${p}`);
    process.exit(1);
  }
  console.log(`✅ ${agentFiles.length} agents, ${skillDirs.length} skills; generated files are up to date.`);
} else {
  for (const p of extra) fs.rmSync(path.join(ROOT, p));
  for (const p of stale) {
    fs.mkdirSync(path.dirname(path.join(ROOT, p)), { recursive: true });
    fs.writeFileSync(path.join(ROOT, p), generated.get(p));
  }
  console.log(`✅ ${agentFiles.length} agents, ${skillDirs.length} skills. Wrote ${stale.length} file(s), removed ${extra.length}.`);
}
