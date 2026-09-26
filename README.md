# pr-autofix

Automated CI failure fixer for GitHub PRs. When CI fails on a pull request, this pipeline:

1. **Diagnoses** the root cause using the CI log
2. **Patches** the code with a cheap LLM (`deepseek/deepseek-v4-flash-0731` via OpenRouter, free models as fallback) fed a structurally compressed diff
3. **Creates** a new `fix/ci-*` branch + PR that auto-merges when CI passes
4. **Closes** the original broken PR once the fix is merged

No code ever leaves GitHub Actions — your tokens stay in your repo secrets.

## Quick setup (3 steps)

### 1. Get secrets

**OPENROUTER_API_KEY** — [openrouter.ai](https://openrouter.ai). The primary model is paid but tiny-priced (`deepseek/deepseek-v4-flash-0731`, $0.021/M input) — with compressed inputs a run costs a fraction of a cent; the account needs a small credit balance. On a free-only account the primary fails and the free ladder takes over automatically. Set repo variable `AUTOFIX_PRIMARY_MODEL=free` to go free-first, or another OpenRouter id to override.

**OPENCODE_GO_API_KEY** (optional, recommended) — OpenCode Go subscription key. When set, every stage tries the Go gateway ladder first (no free-tier 429s); OpenRouter free → cheap paid stays as fallback. A rejected Go key only disables the Go rungs. Either key alone is enough.

**AUTOFIX_PAT** — GitHub Fine-Grained Personal Access Token:
- Go to: Settings → Developer settings → Personal access tokens → Fine-grained tokens
- Repository access: select your repo
- Permissions: `Contents: Read and write`, `Pull requests: Read and write`

Add both to your repo: **Settings → Secrets and variables → Actions → New repository secret**

### 2. Add autofix job to your CI workflow

```yaml
# In your .github/workflows/ci.yml, add this job:

autofix:
  needs: [ci]                          # ← your CI jobs that must finish first
  if: |
    always() &&
    github.event_name == 'pull_request' &&
    !github.event.pull_request.draft &&
    needs.ci.result == 'failure' &&
    !startsWith(github.head_ref, 'fix/ci-')
  permissions:
    contents: write
    pull-requests: write
  uses: trained-assist/pr-autofix/.github/workflows/autofix-callable.yml@v1
  with:
    pr_number: ${{ github.event.pull_request.number }}
    original_branch: ${{ github.head_ref }}
    run_id: ${{ github.run_id }}
  secrets:
    openrouter_api_key: ${{ secrets.OPENROUTER_API_KEY }}
    opencode_go_api_key: ${{ secrets.OPENCODE_GO_API_KEY }}
    gh_token: ${{ secrets.AUTOFIX_PAT || github.token }}
```

### 3. Add cleanup workflow (optional but recommended)

Copy [`templates/ci-fix-cleanup.yml`](templates/ci-fix-cleanup.yml) into your `.github/workflows/`. It automatically closes the original broken PR when the fix PR is merged.

## How it works

The fixer runs in three layers:

**Pre-stage (deterministic, instant):**
- A: Branch out of date → `git merge origin/main` + AI conflict resolution if needed
- B: Missing workflow permissions → patch the YAML automatically
- C: Cloudflare DO migration conflict → diagnose and report (can't auto-fix)

**AI stages** (primary `deepseek/deepseek-v4-flash-0731` → OpenRouter free ladder → cheap paid fallback; OpenCode Go first if its key is set):
- Stage 1: Diagnose root cause + identify files to examine
- Stage 2: Read line-numbered excerpts of those files (around PR-changed and log-cited lines; small files whole). If the model says `MISSING_CONTEXT: <file>`, it gets the full file and retries once
- Stage 3: Return exact search/replace edits (`{file, old_str, new_str}`), validated and applied atomically — no hunk arithmetic for the model to get wrong; one retry with the mismatch errors. A unified diff answer still works (git apply → `--recount` → `patch --fuzz=3`)

**Input compression** (every stage): the PR diff is parsed into hunks and shrunk PR-Agent style — asymmetric context (3 lines before / 1 after), deletion-only hunks and lock/generated/binary files dropped (listed by name), then zero context + collapsed removals, additions cut last, all within a ~4k-token budget. Files cited in the CI log go first. The CI log itself is compressed too (timestamps/ANSI/`##[group]` bodies/runner preamble/post-job cleanup stripped, error lines ±3 kept first, ~2.5k-token budget); deterministic pre-stage checks still see the raw log. Paid calls use OpenRouter `provider.sort=throughput` with reasoning off (stage 3 opts into low reasoning): ~1.5s/call, <$0.001/call. Stage 3 sees the same line-numbered file excerpts as stage 2. Models are told the input is compressed and must say what's missing instead of guessing. Token usage and cost per model land in `ci-fixer-stats.json` and the step summary.

On success, a `fix/ci-*` branch is created with the patch applied. A PR is opened targeting the same base as the original. When CI passes, it auto-merges, and `ci-fix-cleanup.yml` closes the original.

## Batch fixing existing broken PRs

Copy [`templates/batch-fix-prs.yml`](templates/batch-fix-prs.yml) into your `.github/workflows/`, then:

```bash
gh workflow run batch-fix-prs.yml --field pr_numbers="42,41,39"
```

## What it can and can't fix

**Can fix:**
- TypeScript/ESLint errors introduced by the PR
- Missing permissions in workflow YAML
- Branch out of date with main (merge conflicts)
- Simple test failures caused by the PR's own changes

**Cannot fix:**
- Flaky tests unrelated to the PR
- Infrastructure/network failures
- Complex architectural conflicts (reported to humans)
- Cloudflare Durable Object migration issues

## Security

- Your `OPENROUTER_API_KEY` and `AUTOFIX_PAT` never leave GitHub Actions
- The fixer only reads the CI log, your source files, and git history
- It never pushes to `main` or the original branch — always creates a new `fix/ci-*` branch
- PRs marked `draft` are skipped
- `fix/ci-*` branches are never re-fixed (prevents infinite loops)
