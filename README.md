# pr-autofix

Automated CI failure fixer for GitHub PRs. When CI fails on a pull request, this pipeline:

1. **Diagnoses** the root cause using the CI log
2. **Patches** the code with cheap/free LLMs via the [trained-assist-llm-ladder](https://github.com/trained-assist/trained-assist-llm-ladder) worker (model `free-ladder`: OpenCode Go → OpenRouter `:free`), fed a structurally compressed diff
3. **Creates** a new `fix/ci-*` branch + PR that auto-merges when CI passes
4. **Closes** the original broken PR once the fix is merged

No code ever leaves GitHub Actions — your tokens stay in your repo secrets.

## Quick setup (3 steps)

### 1. Get secrets

**LLM_LADDER_TOKEN** — bearer token for the trained-assist-llm-ladder worker (`https://llm-ladder.trainedassist.store`). All model calls go there; the rung order, provider keys, per-model health and failover live in the worker, so pr-autofix carries no model ladder of its own. Repo variable `AUTOFIX_LADDER` picks another ladder name (default `free-ladder`). (`OPENROUTER_API_KEY` / `OPENCODE_GO_API_KEY` are ignored since v1.6.0.)

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
    llm_ladder_token: ${{ secrets.LLM_LADDER_TOKEN }}
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

**AI stages** (every call → llm-ladder worker, model `free-ladder`):
- Stage 1: Diagnose root cause + identify files to examine
- Stage 2: Read line-numbered excerpts of those files (around PR-changed and log-cited lines; small files whole). If the model says `MISSING_CONTEXT: <file>`, it gets the full file and retries once
- Stage 3: Return exact search/replace edits (`{file, old_str, new_str}`), validated and applied atomically — no hunk arithmetic for the model to get wrong; one retry with the mismatch errors. A unified diff answer still works (git apply → `--recount` → `patch --fuzz=3`)

**Agent fix stage** (repo variable `AUTOFIX_AGENT=1`, off by default): after Stage 1, a coding agent ([opencode](https://opencode.ai)) replaces Stages 2–3. It gets the diagnosis, compressed log and diff, reads files, edits, runs the failing tests and iterates (`AUTOFIX_AGENT_TIMEOUT_MIN`, default 20). Its model calls go to the **same llm-ladder worker with the same `LLM_LADDER_TOKEN`**, configured as an OpenAI-compatible provider (`<worker>/v1`, model = ladder name from `AUTOFIX_LADDER`) — no extra secret. The agent does not get the GitHub token; any commits it makes are folded back and `.github/workflows/` edits are dropped. The fix PR's own CI is the verification (category `success:agent` / `fail:agent_no_change` / `fail:agent_error`).

**Input compression** (every stage): the PR diff is parsed into hunks and shrunk PR-Agent style — asymmetric context (3 lines before / 1 after), deletion-only hunks and lock/generated/binary files dropped (listed by name), then zero context + collapsed removals, additions cut last, all within a ~4k-token budget. Files cited in the CI log go first. The CI log itself is compressed too (timestamps/ANSI/`##[group]` bodies/runner preamble/post-job cleanup stripped, error lines ±3 kept first, ~2.5k-token budget); deterministic pre-stage checks still see the raw log. Stage 3 sees the same line-numbered file excerpts as stage 2. Models are told the input is compressed and must say what's missing instead of guessing. Token usage and cost per model land in `ci-fixer-stats.json` and the step summary.

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

- Your `LLM_LADDER_TOKEN` and `AUTOFIX_PAT` never leave GitHub Actions
- The fixer only reads the CI log, your source files, and git history
- It never pushes code to `main` or the original branch — a change it authors (conflict resolution,
  AI patch) always goes to a new `fix/ci-*` branch/PR
- A branch that is only behind `main` and merges cleanly is **not** re-created as a new PR: the fixer
  calls GitHub's update-branch on the original PR (pinned with `expected_head_sha`), so CI re-runs on
  the same PR. Needs `AUTOFIX_PAT` — a push made with `GITHUB_TOKEN` does not trigger a new CI run
- PRs marked `draft` are skipped
- `fix/ci-*` branches are never re-fixed (prevents infinite loops)
