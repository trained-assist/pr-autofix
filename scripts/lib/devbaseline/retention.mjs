// The executor behind `retention.ttl_days` — R4.
//
// Until this module existed the TTL was a NUMBER written into every record and read by nobody:
// `workflow sets retention-days: 90` is configuration of GitHub's artifact storage, and the
// local receipt store had a declared deadline with no owner. A declared deadline nobody executes
// is decoration, not policy (AC-18).
//
// The boundary this owns is the LOCAL receipt store — the directory of JSON records the tool
// writes and the workflows upload. Server-side expiry of uploaded artifacts on GitHub is
// configured by `retention-days` on upload-artifact and is deliberately NOT simulated here:
// no sandbox can force a server clock, and pretending otherwise would trade one fabricated
// proof for another.
//
// Clock is injectable (`now` / `clock`): the regression accelerates 100 days into milliseconds,
// so the test measures the SWEEP, not wall time.
//
// Rules (each is a property the probe checks, not a comment):
//   * expired  = written_at + ttl_days <= now  → removed;
//   * no `written_at` (active run, checkpoint) → NEVER touched, whatever the clock says;
//   * an unreadable record                     → kept and reported in `skipped` — deleting
//                                                what could not be read would be data loss;
//   * repeat sweep                             → removes nothing further (idempotent).

import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 86_400_000;

/**
 * Sweep expired receipts out of `storeDir`.
 * @param {{storeDir: string, now?: number|Date|string, clock?: () => number|Date,
 *          dryRun?: boolean}} opts  dryRun classifies the same way but deletes nothing.
 * @returns {{removed_count: number, removed_paths: string[], kept_count: number,
 *            inspected_count: number, skipped: {path: string, reason: string}[],
 *            now: string, storeDir: string, dry_run: boolean}}
 */
export function sweepExpiredArtifacts({ storeDir, now, clock, dryRun = false } = {}) {
  const report = {
    removed_count: 0,
    removed_paths: [],
    kept_count: 0,
    inspected_count: 0,
    skipped: [],
    now: '',
    storeDir: String(storeDir ?? ''),
    dry_run: !!dryRun,
  };
  if (!storeDir || !fs.existsSync(storeDir)) {
    report.now = new Date(resolveNow(now, clock)).toISOString();
    return report;
  }

  const nowMs = resolveNow(now, clock);
  report.now = new Date(nowMs).toISOString();

  let entries = [];
  try {
    entries = fs.readdirSync(storeDir);
  } catch (e) {
    report.skipped.push({ path: storeDir, reason: `directory unreadable: ${e.message}` });
    return report;
  }

  for (const name of entries) {
    const file = path.join(storeDir, name);
    report.inspected_count++;
    // Only plain files are receipts; subdirectories are not silently descended into.
    let st;
    try {
      st = fs.statSync(file);
    } catch (e) {
      report.skipped.push({ path: name, reason: `stat failed: ${e.message}` });
      continue;
    }
    if (!st.isFile()) {
      report.kept_count++;
      continue;
    }

    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      // Unreadable → kept, never deleted. Reported so a human can look at it.
      report.skipped.push({ path: name, reason: `unreadable: ${e.message}` });
      report.kept_count++;
      continue;
    }

    const retention = record && typeof record === 'object' ? record.retention : null;
    const writtenAt = retention && typeof retention === 'object' ? retention.written_at : null;
    // Active record: no written_at → no deadline → never swept. This is the rule that keeps an
    // in-flight run's receipt alive no matter how far the clock moves.
    if (!writtenAt) {
      report.kept_count++;
      continue;
    }

    const writtenMs = Date.parse(String(writtenAt));
    const ttlDays = Number(retention && retention.ttl_days);
    if (!Number.isFinite(writtenMs) || !Number.isFinite(ttlDays) || ttlDays <= 0) {
      // A record that CLAIMS a deadline but does not carry one that can be computed is kept and
      // reported — an uncomputable deadline is not an expired one.
      report.skipped.push({ path: name, reason: `uncomputable deadline (written_at=${JSON.stringify(writtenAt)}, ttl_days=${JSON.stringify(retention && retention.ttl_days)})` });
      report.kept_count++;
      continue;
    }

    if (writtenMs + ttlDays * DAY_MS <= nowMs) {
      if (dryRun) {
        // Classified as expired, but nothing is touched — the report is the same shape as a real
        // sweep so a caller can diff the two.
        report.removed_count++;
        report.removed_paths.push(name);
        continue;
      }
      try {
        fs.rmSync(file, { force: true });
        report.removed_count++;
        report.removed_paths.push(name);
      } catch (e) {
        report.skipped.push({ path: name, reason: `removal failed: ${e.message}` });
        report.kept_count++;
      }
    } else {
      report.kept_count++;
    }
  }

  report.removed_paths.sort();
  return report;
}

function resolveNow(now, clock) {
  if (now !== undefined && now !== null && now !== '') {
    const ms = now instanceof Date ? now.getTime() : (typeof now === 'number' ? now : Date.parse(String(now)));
    if (Number.isFinite(ms)) return ms;
  }
  if (typeof clock === 'function') {
    const v = clock();
    const ms = v instanceof Date ? v.getTime() : (typeof v === 'number' ? v : Date.parse(String(v)));
    if (Number.isFinite(ms)) return ms;
  }
  return Date.now();
}

export default sweepExpiredArtifacts;
