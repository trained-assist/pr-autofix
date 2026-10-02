# 2026-10-02 — Z01 (итерация 4): два блокера ревью R1/R2 — поставка не мутирует потребителя, receipt не носит чужую identity

Четвёртая выжимка Z01 (предыдущие: `2026-10-01-z01-inventory-dev-baseline.md`,
`2026-10-01-r8-read-state-and-stable-gate.md`,
`2026-10-01-z01-archive-class-of-defects.md`, `2026-10-02-z01-r1-r4-closed.md`).
Итерация 4 закрывает два блокирующих замечания reject-вердикта кросс-ревью итерации 3
(вердикт: trained-agent-architecture#27#issuecomment-5944092098, применение: #37).

## Хронология

1. Итерация 3 (#51, `526d2b7`, релиз `v1.7.7`) закрыла свои четыре блокера, но **способом
   доставки**: pinned full-tree checkout класть дерево инструмента в
   `$GITHUB_WORKSPACE/pr-autofix` — внутрь корня потребителя.
2. Кросс-ревью итерации 3 поймало два следствия раскладки:
   - **R1 (#54, P1):** чистый consumer краснеет на fixtures инструмента
     (`pr-autofix/fixtures/...` — violations не проекта, гейт `blocked/needs_human` на чистом
     репо), а `git add -A` в реальном autofix коммитит незапрошенный gitlink
     `160000 commit … pr-autofix` без `.gitmodules`.
   - **R2 (#55, P2):** receipt гейта называл `GITHUB_WORKFLOW_SHA/REF` (identity **вызывающего**
     workflow по контракту GitHub) сборкой инструмента — сохранённый JSON утверждал
     `tool.commit = <SHA потребителя>`, AC-04/I00-provenance врал достоверным видом.
3. Воспроизведение R5 в изолированной песочнице (synthetic fixtures, mock GitHub, без
   credentials): чистый consumer → exit 1 с violations в fixtures; failed→fix → gitlink в
   коммите; receipt → consumer SHA. 3/3, детерминированно.
4. Фикс — **PR #56, заменённый на #57** (PR неизменяем), squash `fc6c61c`, релиз **v1.7.8**:
   - R1: после checkout шаг «Relocate the tool tree out of the consumer root» — дерево сразу
     уезжает в `$RUNNER_TEMP` во всех 4 точках доставки (devbaseline-callable,
     autofix-callable, ci-fix-cleanup, batch-fix-prs template); все `run:`-пути —
     `$RUNNER_TEMP/pr-autofix/…`. Откат #51 **не** сделан: разделены корни, механизм
     пинованной доставки сохранён.
   - R2: `log.mjs` теряет fallback на `GITHUB_WORKFLOW_*` (без достоверного пина — честное
     `unpinned:local`); devbaseline-callable передаёт `AUTOFIX_WORKFLOW_REF/SHA =
     job.workflow_*` на обоих пишущих шагах (Gate, Inventory).
   - Регрессия в `staging-gate`: `r1-root-separation-probe` и `r2-reusable-receipt-probe` —
     красные на `526d2b7` (11/31 и 7/15), зелёные на фиксе (31/31 и 15/15); обе читают
     **живые** workflow и сохранённые receipt, а не копии.
5. Прод-подтверждение: воспроизведение против тега `v1.7.8` — 9/9 sandbox-проб + selftest
   зелёные; те же пробы с `--code` на дефектном `526d2b7` — падают с точным вердиктом
   (red-контроль, ловит именно поставку). Доказательства: `prod-check/z01-iter4-confirm.md`
   (артефакты плана), CI run `36963162122` success 3/3 на merge-коммите.

## Грабли этой итерации

1. **Локально зелёный ≠ CI зелёный.** Новая проба R1 проходила локально 12/12 и падала в CI
   5/12 (`rm: command not found`): PATH песочницы давал только `fakebin:toolchain`, а на
   раннере `node` живёт в `/opt/hostedtoolcache`, локально — в `/usr/bin`. Проба, воспроизводящая
   shipped-шаг, обязана воспроизводить и окружение раннера (PATH), иначе локальные прогоны лгут.
   Фикс в том же PR-цикле: PATH как в соседней пробе + гард `rm`/`mv`; PR неизменяем → #56
   superseded #57.
2. **Проба должна исполнять ЛАЙВЫЕ шаги, а не читать YAML.** Пробы итерации 3 не ловили R1/R2,
   потому что baseline/fix-тесты запускали CLI **снаружи** consumer-корня, а штатный
   cleanup-probe проверял другой workflow. `r1-root-separation-probe` парсит актуальные
   `run:`-блоки и исполняет их в синтетическом consumer — единственный способ поймать класс
   «раскладка доставки», а не «код скрипта».
3. **Установка инструмента не должна менять потребителя — инвариант, а не привычка.**
   Проверяется исполнением: чистый consumer → exit 0; no-change → пустой индекс; failed→fix →
   только пути consumer, ноль tooling gitlink. Подавление (SKIP_DIRS/gitignore/ослабление
   diff-gate) вердиктом запрещено — оно прячет симптом, не причину.
4. **Caller ≠ tool identity, всегда.** `github.*` в reusable workflow — это потребитель;
   identity инструмента даёт только доставленный пин (`job.*` → `AUTOFIX_WORKFLOW_*`).
   Форма «40-hex» не различает caller/tool SHA, поэтому «валидация формы» не спасает.
   Честное `unpinned:local` лучше врущей достоверности. Класс уже закрыт для `autofix.mjs`
   в итерации 3 — итерация 4 дочистила весь log-контракт (пробы это доказывают).

## Что закрыто / что осталось

- Закрыто: блокеры `#54` (R1) и `#55` (R2) — комментарии с доказательствами + close;
  фикс в проде с `v1.7.8`.
- Признанные прошлым ревью исправления не откатывались: pinned delivery, cleanup-проверки,
  patch/source slots, combined gate receipt — сохранены (проверено пробами итерации 3).
- Отдельными issues, не «чинится» смягчением чек-листа: `#52` (17 legacy slots), `#58`
  (caller-as-tool в шаблоне batch-fix-prs — политика пина), `#42` (required checks),
  исторический staging, org-wide rollout.
- Галочки в `trained-agent-architecture#37` и Status в Project не менялись — это делает шаг
  обновления плана.

Refs https://github.com/trained-assist/trained-agent-architecture/issues/37
