# Participating repositories — the inventory input

`repos.json` is an **input**, not a discovery result. It was assembled once, by hand, from

* the "Scope границ репозиториев" section of `IMPLEMENTATION-AND-INTEGRATION-PLAN.md` (line 108),
* the architect's audit of the organisation (issue `trained-agent-architecture#27`),
* the list of repositories under `trained-assist` at the time of writing (25 entries).

Silent discovery was rejected on purpose: a table that enumerates whatever the API happens to
return cannot be checked by acceptance — nobody can say what the right answer was.

## Fields

| field | meaning |
|---|---|
| `repo` | `owner/name`. Required. |
| `type_hint` | `docs` / `node` / `python` / `mixed` / `null`. `null` means "derive it from the file tree" — the default and the honest one. A hint is a human claim, so it is used only when someone wrote it. |
| `ci_required` | `true` / `false` / `null`. `null` means *unknown*, and unknown becomes a construction task instead of a green tick. The inventory records presence of a workflow, never "this job is required". |
| `note` | why the repository is in scope. Free text, not parsed. |
| `path` | **offline only** — a local checkout to scan instead of calling the GitHub API. Used by the staging rehearsal so it never touches the network. |

## Credentials

Credential **names** only, and only inside a per-repository `.devbaseline.json`. Values are a
schema violation: the adapter validator and the inventory writer both refuse to emit a
credential-shaped value (AC-07).

## Regenerating the table

```sh
node scripts/devbaseline.mjs inventory --out docs/inventory
```

Writes `repo-coverage.json`, `repo-coverage.md` and `construction-tasks.md`. The two `.md`/`.json`
coverage files are committed into `trained-assist/trained-agent-architecture` (the repository that
owns the table); `construction-tasks.md` is a review artefact and is not committed.

Exit code is `0` even when repositories are unreadable — an unreadable repository is a **row**,
not a broken run, and failing the whole inventory because one checkout is missing would train
everyone to ignore the code. `--strict` turns unreadable rows into exit code `4` for the gate that
must not accept a blind spot.