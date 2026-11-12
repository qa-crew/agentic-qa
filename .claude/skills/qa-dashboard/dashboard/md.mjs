// A small markdown → HTML renderer for AIQA's own documents (requirements, plans, test cases, reports).
// Everything is HTML-escaped first; the only markup that survives is what this file emits, plus <br> inside
// table cells (the test-case format uses it). Links are kept only for http(s), relative paths and #anchors.

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const safeHref = (href) => (/^(https?:\/\/|#|\.{0,2}\/|[\w.-]+(\/|$|\.))/i.test(href) && !/^\s*javascript:/i.test(href) ? href : "");

export function inline(text) {
  const codes = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/&lt;br\s*\/?&gt;/gi, "<br>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
      const h = safeHref(href.replace(/&amp;/g, "&"));
      return h ? `<a href="${esc(h)}">${label}</a>` : label;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

function splitCells(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (s[i] === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

const isSeparator = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/** Strip a leading `---` front-matter block. */
export function stripFrontMatter(text) {
  return text.replace(/^﻿/, "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

export function renderMarkdown(text) {
  const lines = stripFrontMatter(text).split(/\r?\n/);
  const out = [];
  let i = 0;
  const para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para.length = 0;
  };
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { flush(); i++; continue; }
    const fence = t.match(/^(```|~~~)\s*([\w+-]*)/);
    if (fence) {
      flush();
      const body = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      i++;
      out.push(`<pre><code${fence[2] ? ` data-lang="${esc(fence[2])}"` : ""}>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = t.match(/^(#{1,6})\s+(.*?)\s*#*$/);
    if (h) {
      flush();
      const level = h[1].length;
      const id = h[2].toLowerCase().replace(/[^\w]+/g, "-").replace(/^-|-$/g, "");
      out.push(`<h${level} id="${esc(id)}">${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flush(); out.push("<hr>"); i++; continue; }
    if (t.startsWith("|") && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      flush();
      const head = splitCells(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].trim().startsWith("|"); i++) rows.push(splitCells(lines[i]));
      out.push(
        `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>` +
          rows.map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? "")}</td>`).join("")}</tr>`).join("") +
          `</tbody></table></div>`
      );
      continue;
    }
    if (t.startsWith(">")) {
      flush();
      const body = [];
      for (; i < lines.length && lines[i].trim().startsWith(">"); i++) body.push(lines[i].trim().replace(/^>\s?/, ""));
      out.push(`<blockquote>${renderMarkdown(body.join("\n"))}</blockquote>`);
      continue;
    }
    if (LIST.test(line)) {
      flush();
      const items = [];
      for (; i < lines.length; i++) {
        const l = lines[i];
        if (!l.trim()) {
          if (i + 1 < lines.length && (LIST.test(lines[i + 1]) || /^\s{2,}\S/.test(lines[i + 1]))) continue;
          break;
        }
        const m = l.match(LIST);
        if (m) items.push({ indent: m[1].replace(/\t/g, "    ").length, ordered: /\d/.test(m[2]), text: m[3] });
        else if (/^\s+\S/.test(l) && items.length) items[items.length - 1].text += " " + l.trim();
        else break;
      }
      out.push(renderList(items));
      continue;
    }
    para.push(t);
    i++;
  }
  flush();
  return out.join("\n");
}

function renderList(items) {
  const html = [];
  const stack = [];
  for (const it of items) {
    while (stack.length && it.indent < stack[stack.length - 1].indent) html.push(`</li></${stack.pop().tag}>`);
    const top = stack[stack.length - 1];
    if (!top || it.indent > top.indent) {
      const tag = it.ordered ? "ol" : "ul";
      stack.push({ indent: it.indent, tag });
      html.push(`<${tag}>`);
    } else html.push("</li>");
    const task = it.text.match(/^\[([ xX])\]\s+(.*)$/);
    html.push(task ? `<li class="task"><input type="checkbox" disabled${task[1].trim() ? " checked" : ""}> ${inline(task[2])}` : `<li>${inline(it.text)}`);
  }
  while (stack.length) html.push(`</li></${stack.pop().tag}>`);
  return html.join("");
}

/** The body of `## <name>` (up to the next level-1/2 heading), or "" when the section is missing. */
export function sectionText(text, name) {
  const lines = stripFrontMatter(text).split(/\r?\n/);
  const i = lines.findIndex((l) => new RegExp(`^##\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i").test(l.trim()));
  if (i === -1) return "";
  const out = [];
  for (let j = i + 1; j < lines.length && !/^#{1,2}\s/.test(lines[j]); j++) out.push(lines[j]);
  return out.join("\n").trim();
}
