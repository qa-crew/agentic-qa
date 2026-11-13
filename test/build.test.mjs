import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("generated files are up to date", () => {
  const r = spawnSync(process.execPath, ["scripts/build.mjs", "--check"], { cwd: ROOT, encoding: "utf-8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test("plugin.json lists every agent and the marketplace points at this repo", () => {
  const plugin = JSON.parse(fs.readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf-8"));
  const agents = fs.readdirSync(new URL("../.claude/agents/", import.meta.url)).filter((f) => f.endsWith(".md"));
  assert.equal(plugin.agents.length, agents.length);
  assert.deepEqual(plugin.skills, ["./.claude/skills/"]);
  const market = JSON.parse(fs.readFileSync(new URL("../.claude-plugin/marketplace.json", import.meta.url), "utf-8"));
  const entry = market.plugins.find((p) => p.name === plugin.name);
  assert.equal(entry.source, "./");
  assert.equal(entry.version, plugin.version);
});

test("the docs' install commands and command prefix match the plugin, the marketplace and the repository", () => {
  const plugin = JSON.parse(fs.readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf-8"));
  const market = JSON.parse(fs.readFileSync(new URL("../.claude-plugin/marketplace.json", import.meta.url), "utf-8"));
  const repo = new URL(plugin.repository).pathname.replace(/^\/|\.git$/g, "");
  const id = `${plugin.name}@${market.name}`;
  assert.equal(plugin.homepage, plugin.repository);
  const files = [
    "README.md", "CHANGELOG.md", "docs/tutorial/index.html", "examples/saucedemo/README.md",
    ".claude/skills/qa-pipeline/SKILL.md", ".claude/skills/qa-story/SKILL.md", ".claude/skills/qa-dashboard/dashboard/page.html",
  ];
  let seen = 0;
  for (const f of files) {
    const text = fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf-8");
    const each = (re, want) => { for (const m of text.matchAll(re)) { seen++; assert.equal(m[1], want, `${f}: ${m[0]}`); } };
    each(/(?:marketplace add|--marketplace) ([\w.-]+\/[\w.-]+)/g, repo);
    each(/"repo": "([^"]+)"/g, repo);
    each(/(?:plugin (?:install|update)|"enabledPlugins": \{) "?([\w-]+@[\w-]+)/g, id);
    each(/marketplace update ([\w-]+)/g, market.name);
    each(/\/([\w-]+):qa-(?:pipeline|story|setup|dashboard)\b/g, plugin.name);
  }
  assert.ok(seen > 20, `only ${seen} install commands found; did the patterns stop matching?`);
});

test("the docs site only links to files inside docs/, so it works on GitHub Pages", () => {
  const docs = fileURLToPath(new URL("../docs/", import.meta.url));
  for (const f of ["index.html", "tutorial/index.html"]) {
    const file = path.join(docs, f);
    const html = fs.readFileSync(file, "utf-8");
    for (const m of html.matchAll(/(?:href|src)="([^"#]+)/g)) {
      const link = m[1];
      if (/^(https?:|mailto:|data:)/.test(link)) continue;
      const target = path.resolve(path.dirname(file), link);
      assert.ok(target.startsWith(docs), `${f}: ${link} leaves docs/`);
      assert.ok(fs.existsSync(target), `${f}: ${link} doesn't exist`);
    }
  }
  assert.ok(fs.existsSync(path.join(docs, ".nojekyll")), "docs/.nojekyll is missing");
});

test("every agent carries the git rule and never waits for a user", () => {
  for (const f of fs.readdirSync(new URL("../.claude/agents/", import.meta.url))) {
    const text = fs.readFileSync(new URL(`../.claude/agents/${f}`, import.meta.url), "utf-8");
    assert.match(text, /NEVER run git commands that change the repository/, f);
    assert.match(text, /There is NO interactive user available/, f);
  }
});
