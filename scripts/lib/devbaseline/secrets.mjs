// Secret-shaped value detection — one implementation, shared by every artefact pr-autofix
// writes (adapter validation, coverage table, log records). Same pattern class as
// SECRET_PATTERNS in software-engineering-playbooks/src/registry.js; ~8 duplicated lines
// across two repositories is the accepted price of one schema with two owners (D6).
//
// The rule that matters: a NAME is fine, a VALUE is not. `credentials: [{name:
// "LLM_LADDER_TOKEN"}]` is the contract; `token: "gho_..."` anywhere is a violation.

export const SECRET_VALUE_PATTERNS = [
  { id: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { id: 'openai_key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { id: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'aws_key_id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/ },
  { id: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  // Long opaque hex that sits in the same record as a credential-ish word.
  { id: 'opaque_hex_with_token_word', re: /\b[A-Fa-f0-9]{40,}\b(?=[^\n]{0,80}(?:TOKEN|SECRET|PASSWORD|KEY))/ },
];

/** True when `text` contains something shaped like a credential value. */
export function looksLikeSecret(text) {
  if (typeof text !== 'string' || !text) return false;
  return SECRET_VALUE_PATTERNS.find(p => p.re.test(text)) || null;
}

/** Every violation in `text`, as {path, rule_id, message} for the coverage table. */
export function scanForSecrets(text, at = '') {
  if (typeof text !== 'string') return [];
  return SECRET_VALUE_PATTERNS
    .filter(p => p.re.test(text))
    .map(p => ({ path: at || '(value)', rule_id: 'adapter_schema_violation', message: `looks like a secret value (${p.id})` }));
}

/**
 * Walk a parsed JSON value and collect secret-shaped values together with their path.
 * Used on adapters and on log records — anywhere a value must never appear (AC-07).
 */
export function findSecretValues(value, at = '') {
  const hits = [];
  const visit = (v, p) => {
    if (typeof v === 'string') { for (const h of scanForSecrets(v, p)) hits.push(h); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => visit(x, `${p}[${i}]`)); return; }
    if (v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) visit(x, p ? `${p}.${k}` : k); }
  };
  visit(value, at);
  return hits;
}

/** Redact secret-shaped substrings in free text (CLI output, step summaries). */
export function redact(text) {
  let out = String(text ?? '');
  for (const p of SECRET_VALUE_PATTERNS) out = out.replace(new RegExp(p.re.source, 'g'), `[redacted:${p.id}]`);
  return out;
}