import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
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

test("every agent carries the git rule and never waits for a user", () => {
  for (const f of fs.readdirSync(new URL("../.claude/agents/", import.meta.url))) {
    const text = fs.readFileSync(new URL(`../.claude/agents/${f}`, import.meta.url), "utf-8");
    assert.match(text, /NEVER run git commands that change the repository/, f);
    assert.match(text, /There is NO interactive user available/, f);
  }
});
