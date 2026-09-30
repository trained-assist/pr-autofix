// check-docs — the deterministic documentation check.
//
// A docs-only repository is not a repository without a check; it is a repository whose check
// is not a compiler. This is that check: relative links resolve, JSON parses, documents have
// a top-level heading. No network, no model, no build. Rule IDs come from the fixed
// dictionary: docs_link_broken · docs_json_invalid · docs_heading_missing.

import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.devbaseline-sandbox', 'dist', 'build', 'coverage', 'vendor', '__pycache__', '.venv', 'venv']);
const MAX_BYTES = 512 * 1024;

// [text](target) — target only. Reference links and autolinks are out of scope on purpose.
const MD_LINK_RE = /\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const EXTERNAL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|mailto:)/i;
const H1_RE = /^#\s+\S/m;

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out); continue; }
    out.push(path.join(dir, e.name));
  }
  return out;
}

/**
 * @returns {{ok: boolean, violations: {rule_id: string, path: string, message: string}[], scanned: {md: number, json: number}}}
 */
export function checkDocs(dir) {
  const violations = [];
  let md = 0, json = 0;
  for (const file of walk(dir)) {
    const rel = path.relative(dir, file);
    if (/\.(md|markdown)$/i.test(file)) {
      md++;
      let text;
      try {
        if (fs.statSync(file).size > MAX_BYTES) continue;
        text = fs.readFileSync(file, 'utf8');
      } catch { continue; }

      if (!H1_RE.test(text)) {
        violations.push({ rule_id: 'docs_heading_missing', path: rel, message: 'no top-level (#) heading' });
      }
      // Links inside fenced code blocks are examples, not references — skip fenced regions.
      const unfenced = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
      for (const m of unfenced.matchAll(MD_LINK_RE)) {
        const raw = m[1].replace(/^<|>$/g, '');
        if (!raw || EXTERNAL_RE.test(raw)) continue;
        const target = raw.split('#')[0].split('?')[0];
        if (!target) continue;
        const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
        if (!fs.existsSync(resolved)) {
          violations.push({ rule_id: 'docs_link_broken', path: rel, message: `link target does not exist: ${raw}` });
        }
      }
    } else if (/\.json$/i.test(file)) {
      json++;
      const rel2 = path.relative(dir, file);
      try {
        const raw = fs.readFileSync(file, 'utf8');
        if (raw.trim()) JSON.parse(raw);
      } catch (e) {
        violations.push({ rule_id: 'docs_json_invalid', path: rel2, message: `invalid JSON: ${e.message.slice(0, 120)}` });
      }
    }
  }
  violations.sort((a, b) => a.path.localeCompare(b.path) || a.rule_id.localeCompare(b.rule_id));
  return { ok: violations.length === 0, violations, scanned: { md, json } };
}

/** One line per violation — the rule id is printed verbatim so a log can be grepped for it. */
export function formatViolations(violations) {
  return violations.map(v => `${v.rule_id}: ${v.path}: ${v.message}`).join('\n');
}