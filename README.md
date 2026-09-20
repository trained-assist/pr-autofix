# pr-autofix

Automated CI failure fixer for GitHub PRs. When CI fails on a pull request, this pipeline:

1. **Diagnoses** the root cause using the CI log
2. **Patches** the code with OpenRouter free-tier AI models
3. **Creates** a new `fix/ci-*` branch + PR that auto-merges when CI passes
4. **Closes** the original broken PR once the fix is merged

No code ever leaves GitHub Actions — your tokens stay in your repo secrets.

## Quick setup (3 steps)

### 1. Get secrets

**OPENROUTER_API_KEY** — [openrouter.ai](https://openrouter.ai), free account, free models are used by default.

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

**AI stages (OpenRouter free models):**
- Stage 1: Diagnose root cause + identify files to examine
- Stage 2: Read the actual files, understand the changes
- Stage 3: Write a unified diff to fix the issue

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
