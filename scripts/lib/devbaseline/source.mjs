// Repository sources: the ONE place that answers "what is in this repository".
//
// Both inventory paths — a local checkout and the live GitHub API — reduce to the same three
// questions: which files exist, what is in one of them, and where did this come from. As long
// as the derivation of a coverage row needs only those three answers, local and live cannot
// drift: there is exactly one derivation, and it never touches the filesystem itself.
//
// This module is what removes the F1/F2 class of defect, where the live path filled 5 of 18
// columns and decided "staging absent" from a workflow NAME while the local path read workflow
// contents. A second implementation of "what is in this repository" is exactly how a coverage
// table starts lying.
//
// A source never writes, never executes anything from the repository, and never returns a value
// it did not read: `null` means "absent or unreadable", and both are reported, never guessed.

import fs from 'node:fs';
import path from 'node:path';

/** Base URL of the API. Overridable so the sandbox can point at its own endpoint (AC-09). */
export const ghApiBase = () => process.env.DEVBASELINE_GITHUB_API || 'https://api.github.com';

/**
 * A local checkout. The file list is read once; content is read on demand from disk.
 * @param {string} dir
 */
export function localSource(dir) {
  const root = path.resolve(dir);
  const files = new Set();
  let readable = false;
  if (fs.existsSync(root)) {
    readable = true;
    const add = (d) => {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const rel = path.relative(root, path.join(d, e.name));
        files.add(rel);
        if (e.isDirectory()) add(path.join(d, e.name));
      }
    };
    add(root);
  }
  return {
    kind: 'local',
    origin: root,
    readable,
    // Three states, not two. A missing directory and a directory the reader may not open are
    // different facts, and the difference is a construction task, not a formatting detail.
    readState: readable ? 'read' : 'no_access',
    files,
    has: (rel) => files.has(String(rel).replace(/^\.\//, '')),
    async readText(rel) {
      const p = path.join(root, String(rel));
      try {
        if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) return null;
        return fs.readFileSync(p, 'utf8');
      } catch { return null; }
    },
  };
}

/**
 * A live repository over the GitHub API — read-only, no token beyond the reader's own.
 *
 * The file list comes from ONE recursive tree request (`/git/trees/{branch}?recursive=1`),
 * because "what exists" and "what is in it" must be answered from the same snapshot: two
 * separate listings can straddle a push and produce a row that never existed.
 *
 * Readability is answered in TWO steps, because GitHub answers `404` for two different reasons:
 * the repository does not exist, or this token may not see it. They are the same HTTP status and
 * opposite facts, so a repository whose METADATA reads (and whose tree does not — a repository
 * with no commit on its default branch) is READ, and simply empty. Before this split that
 * repository was reported as `unreadable`, which told the reader to go and fix permissions for a
 * repository that needed nothing — and, worse, put a row whose content depended on the TOKEN's
 * scope inside a byte-exact drift gate (R8).
 *
 * @param {{owner: string, name: string, token?: string, fetchImpl?: typeof fetch}} opts
 */
export async function liveSource({ owner, name, token = process.env.GH_TOKEN, fetchImpl = fetch }) {
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const call = async (p) => {
    const r = await fetchImpl(`${ghApiBase()}/repos/${owner}/${name}${p}`, { headers });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };

  let repo;
  try {
    repo = await call('');
  } catch (e) {
    // Metadata itself is refused: the repository is invisible to THIS reader. Which of the two
    // reasons it is, we cannot know from the status code, and we do not guess.
    const err = new Error(`HTTP ${/(\d{3})/.exec(e.message)?.[1] || '?'}`);
    err.readerScope = true;
    throw err;
  }
  const branch = repo.default_branch;

  // Blobs and trees are both recorded: a directory is a legitimate answer to `has('docs')`,
  // and the local path answers it with existsSync — the two must agree.
  let tree = { tree: [], truncated: false };
  let empty = false;
  try {
    tree = await call(`/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  } catch {
    // The repository answered, so it is readable. A default branch with no tree is a repository
    // with no commit yet — a real, onboardable state.
    empty = true;
  }
  const files = new Set((tree.tree || []).map(e => e.path));

  const cache = new Map();
  const readText = async (rel) => {
    const key = String(rel);
    if (cache.has(key)) return cache.get(key);
    const enc = key.split('/').map(encodeURIComponent).join('/');
    let text = null;
    try {
      const c = await call(`/contents/${enc}?ref=${encodeURIComponent(branch)}`);
      if (c && c.encoding === 'base64' && typeof c.content === 'string') {
        text = Buffer.from(c.content.replace(/\n/g, ''), 'base64').toString('utf8');
      }
    } catch { text = null; }
    cache.set(key, text);
    return text;
  };

  return {
    kind: 'live',
    origin: `${ghApiBase()}/repos/${owner}/${name}@${branch}`,
    readable: true,
    readState: 'read',
    empty,
    defaultBranch: branch,
    truncated: tree.truncated === true,
    files,
    has: (rel) => files.has(String(rel).replace(/^\.\//, '')),
    readText,
  };
}

/** Workflow files present in a source, sorted so two runs produce the same list. */
export function workflowFiles(source) {
  return [...source.files]
    .filter(f => f.startsWith('.github/workflows/') && /\.ya?ml$/.test(f))
    .sort();
}
