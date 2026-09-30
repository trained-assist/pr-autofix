# onboarding-fixture

A miniature repository used to rehearse the development baseline end to end
(`node scripts/devbaseline.mjs verify --repo fixtures/onboarding-repo`).

It carries **three deliberate defects**. They are the point of the fixture, not mistakes:

| planted defect | detected by | rule id |
|---|---|---|
| `lint.js` exits 1, and `npm test` runs it | derived check | `check_command_failed` |
| `docs/config.json` is not valid JSON | `check-docs` | `docs_json_invalid` |
| `docs/notes.md` links to a file that does not exist | `check-docs` | `docs_link_broken` |

`check.js` passes and `src/sum.js` is correct, so a red run means "the planted defect was found",
never "the fixture itself is broken".

Everything here is offline: no network call, no credential value, no production profile.
