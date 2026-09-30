#!/usr/bin/env node
// Z01 sandbox — замкнутый цикл сценария «inventory и общий development baseline».
//
//   node scripts/sandbox/z01-devbaseline.mjs        # одна команда, детерминированный pass/fail
//   node scripts/sandbox/z01-devbaseline.mjs --keep # не удалять рабочий каталог прогона
//
// Уровень автономности — S3 (autotests с моками внешних зависимостей, fixture, офлайн).
// Время цикла — 0.3 с (замерено, 3 прогона подряд). Внешних сетевых вызовов нет вообще:
// дочерние процессы запускаются с прокси на мёртвый порт и с PATH без `gh`/`npm`,
// поэтому «инвентарь не ходит в сеть» и «construction-tasks по умолчанию dry-run» —
// не декларации, а проверяемые свойства прогона.
//
// Этот же скрипт — тело джоба `staging-gate` в .github/workflows/ci.yml (дизайн §2.5):
// репетиция боевого пути на fixture. Прод-сервиса у pr-autofix нет, поэтому staging здесь —
// репетиция, и это объявлено в fidelity declaration (AC-06), а не названо облачной проверкой.
//
// ── Контракт, который закрепляет эта песочница ─────────────────────────────────
// Проверки идут через CLI как через ВНЕШНИЙ контракт (AC-19): подпроцесс `node scripts/devbaseline.mjs`,
// а не вызов внутренней функции. Коды возврата и имена флагов взяты из дизайна §2.1
// (`validate` 0/3 · `verify` 0/1/2/3 · `context` 0/2/3 · `inventory` 0/4 · `check-docs` 0/1).
// Два минимальных добавления к §2.1, нужные офлайн-детерминизму (срезы T6/T4/T8 обязаны
// их реализовать, других способов у песочницы нет):
//   * `inventory --repos <file>` — путь к списку репозиториев вместо `inventory/repos.json`;
//     записи допускают поле `path` (локальный checkout) — офлайн-скан вместо GitHub API.
//   * `verify --log <file>` — явный путь log-записи (AC-44) вместо вывода в stdout.
//
// ── Границы покрытия ───────────────────────────────────────────────────────────
// В pr-autofix проверяются S1, S2, S3, S4, S6, S7 (срезы T1–T8). Шаги S5 (одна процедура
// setup→run→evidence→teardown, срез T10) и S8 (coverage-drift, срез T11) принадлежат
// другим репозиториям и здесь помечены `deferred` со владельцем — красными они не станут.
// Локальный bare-репозиторий как endpoint песочницы (AC-09) создаётся уже сейчас,
// чтобы T10 не зависел от временного ssh-алиаса `vm`.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const CLI = path.join(REPO, 'scripts', 'devbaseline.mjs');
const KEEP = process.argv.includes('--keep');

// Фиксированный словарь rule ID из дизайна §2.4. Проверка логов идёт по нему:
// rule_id вне словаря = регресс контракта, даже если поле заполнено.
const RULE_IDS = new Set([
  'workflow_edited', 'test_disabled', 'assertion_removed', 'test_file_deleted', 'lock_file_touched',
  'too_many_files', 'too_many_lines', 'docs_link_broken', 'docs_json_invalid', 'docs_heading_missing',
  'adapter_schema_violation', 'profile_unknown', 'check_command_failed', 'cap_exhausted',
  'unsupported_by_profile',
]);

// Поля AC-44, которые обязаны быть в каждой log-записи (дизайн §2.4).
const AC44_FIELDS = [
  ['rule_id'], ['tool', 'name'], ['tool', 'version'], ['tool', 'commit'],
  ['attempt_count'], ['patch_refs'], ['source', 'base_commit'], ['source', 'head_commit'],
  ['included_paths'], ['omitted_paths'], ['budget'], ['retention'],
];

// ── Мини-asserts ───────────────────────────────────────────────────────────────
let okCount = 0, failCount = 0, skipCount = 0;
const failures = [];

const ok = (name, detail = '') => { okCount++; console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`); };
const fail = (name, detail = '') => { failCount++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); };
const skip = (name, reason) => { skipCount++; console.log(`skip ${name} — ${reason}`); };
const check = (name, cond, detail = '') => (cond ? ok(name, detail) : fail(name, detail));

const group = (title) => console.log(`\n# ${title}`);

/** Значение по пути-ключу: get(obj, ['tool','version']). */
const get = (obj, keys) => keys.reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Секреты — имена/значения, которые не должны появляться в артефактах песочницы (AC-07/AC-08). */
const SECRET_VALUE_RE = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,        // GitHub token
  /sk-[A-Za-z0-9]{20,}/,              // OpenAI-подобный
  /xox[baprs]-[A-Za-z0-9-]{10,}/,     // Slack
  /AKIA[0-9A-Z]{16}/,                 // AWS
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, // JWT
  /\b[A-Fa-f0-9]{40}\b(?=[^\n]*TOKEN)/,
];
const looksLikeSecretValue = (s) => SECRET_VALUE_RE.some((re) => re.test(s));

// ── Запуск дочерних процессов ─────────────────────────────────────────────────
// Прокси на мёртвый порт: любая попытка сети в дочернем процессе падает вместо того,
// чтобы «случайно» пройти (R18 — сеть не используется).
const OFFLINE_ENV = {
  HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9',
  http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9',
  NO_PROXY: '', no_proxy: '', GIT_TERMINAL_PROMPT: '0', DEVBASELINE_OFFLINE: '1',
};

function run(cmd, args, { cwd = REPO, env = {}, cleanPath = false } = {}) {
  const e = { ...process.env, ...OFFLINE_ENV, ...env };
  if (cleanPath) {
    // Фикстура для dry-run: PATH без gh/npm/npx — construction-tasks не имеет права
    // создавать Issue, и это проверяется absence'ом инструмента, а не декларацией.
    e.PATH = path.join(RUN, 'fakebin');
  }
  const r = spawnSync(cmd, args, { cwd, env: e, encoding: 'utf8', timeout: 120_000 });
  return { code: r.status ?? -1, out: (r.stdout || '') + (r.stderr || '') };
}

/** node scripts/devbaseline.mjs <args> — единственная точка входа в проверяемый контракт. */
const cli = (args, opts = {}) => run(process.execPath, [CLI, ...args], opts);

// ── Рабочий каталог прогона (своя папка, не общий /tmp) ───────────────────────
const RUN = path.resolve(process.env.DEVBASELINE_SANDBOX_TMP || path.join(REPO, '.devbaseline-sandbox'));
const FX = path.join(RUN, 'fixtures');
const OUT = path.join(RUN, 'out');

const w = (rel, content) => {
  const p = path.join(FX, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
};
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

fs.rmSync(RUN, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// Только node и git в PATH — см. run({cleanPath:true}).
fs.mkdirSync(path.join(RUN, 'fakebin'), { recursive: true });
for (const tool of ['node', 'git']) {
  const src = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
  if (src) fs.symlinkSync(src, path.join(RUN, 'fakebin', tool));
}

// ── Фикстуры (offline, детерминированные, без env-секретов — AC-08) ────────────
const CHECK_OK = 'process.exit(0);';
const CHECK_FAIL = 'console.error("lint failed: intentional fixture error");\nprocess.exit(1);';

// 1. docs-only: только markdown + CI. Ни package.json, ни pyproject.toml → профиль docs.
w('docs-only/README.md', '# Docs only\n\nДокументация без кода. См. [гайд](docs/guide.md).\n');
w('docs-only/docs/guide.md', '# Гайд\n\nОтносительная ссылка рабочая: [назад](../README.md).\n');
w('docs-only/.github/workflows/ci.yml', 'name: CI\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n');

// 2. node-clean: положительный путь S1/S6 — check зелёный, fixer зарегистрирован.
w('node-clean/package.json', JSON.stringify({ name: 'clean-app', version: '1.0.0', scripts: { test: 'node check.js' } }, null, 2));
w('node-clean/check.js', CHECK_OK);
w('node-clean/src/sum.js', 'export const sum = (a, b) => a + b;\n');
w('node-clean/.github/workflows/ci.yml', 'name: CI\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n');
w('node-clean/.github/workflows/autofix-callable.yml', 'name: autofix\non:\n  workflow_call:\n    inputs: {}\njobs:\n  fix:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo fix\n');

// 3. node-broken: контролируемое падение S6 — check красный, fixer есть.
w('node-broken/package.json', JSON.stringify({ name: 'broken-app', version: '1.0.0', scripts: { test: 'node check.js' } }, null, 2));
w('node-broken/check.js', CHECK_FAIL);
w('node-broken/.github/workflows/ci.yml', 'name: CI\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n');
w('node-broken/.github/workflows/autofix-callable.yml', 'name: autofix\non:\n  workflow_call:\n    inputs: {}\njobs:\n  fix:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo fix\n');

// 4. no-fixer-app: check красный, но fixer'а в профиле нет → needs_human (код 2),
//    а не controlled failure. Разделяет «есть чем чинить» и «чинить нечем».
w('no-fixer-app/package.json', JSON.stringify({ name: 'no-fixer-app', version: '1.0.0', scripts: { test: 'node check.js' } }, null, 2));
w('no-fixer-app/check.js', CHECK_FAIL);

// 5. broken-docs: контролируемое падение check-docs — битая относительная ссылка
//    и невалидный JSON (rule IDs docs_link_broken / docs_json_invalid, §2.4).
w('broken-docs/README.md', '# Broken docs\n\nБитая ссылка: [нет такого](./missing-target.md)\n');
w('broken-docs/data.json', '{ "not": "closed",, }\n');

// 6. Контекстные манифесты S4: fresh (реальный sha) / stale (чужой sha) / missing (файла нет).
const ctxRepo = path.join(FX, 'ctx-repo');
fs.mkdirSync(ctxRepo, { recursive: true });
const gitEnv = { GIT_AUTHOR_NAME: 'sandbox', GIT_AUTHOR_EMAIL: 'sandbox@example.invalid', GIT_COMMITTER_NAME: 'sandbox', GIT_COMMITTER_EMAIL: 'sandbox@example.invalid' };
run('git', ['init', '-q', '-b', 'main', '.'], { cwd: ctxRepo });
w('ctx-repo/src/index.js', 'export const v = 1;\n');
run('git', ['add', '-A'], { cwd: ctxRepo });
run('git', ['commit', '-q', '-m', 'fixture'], { cwd: ctxRepo, env: gitEnv });
const CTX_SHA = (run('git', ['rev-parse', 'HEAD'], { cwd: ctxRepo }).out || '').trim();
w('ctx-repo/.devbaseline-context.json', JSON.stringify({ schema_version: 1, source_commit: CTX_SHA, entrypoints: ['src/index.js'] }, null, 2));
w('ctx-repo/.devbaseline-context.stale.json', JSON.stringify({ schema_version: 1, source_commit: '0'.repeat(40), entrypoints: ['src/index.js'] }, null, 2));

// 7. Endpoint песочницы (AC-09): собственный bare-репозиторий, не ssh-алиас `vm`.
const ENDPOINT = path.join(RUN, 'endpoint.git');
run('git', ['init', '-q', '--bare', ENDPOINT], { cwd: RUN });

// 8. Список репозиториев для S1: локальные checkout'ы, `path` вместо GitHub API.
const REPOS_FILE = path.join(RUN, 'repos.json');
fs.writeFileSync(REPOS_FILE, JSON.stringify([
  { repo: 'sandbox/docs-only', type_hint: 'docs', path: path.join(FX, 'docs-only') },
  { repo: 'sandbox/node-clean', type_hint: 'node', path: path.join(FX, 'node-clean') },
  { repo: 'sandbox/node-broken', type_hint: 'node', path: path.join(FX, 'node-broken') },
  { repo: 'sandbox/unreadable', type_hint: null, path: path.join(FX, 'does-not-exist') },
], null, 2));

// ── A. Здоровье самой песочницы (должно быть зелёным ДО появления фичи) ────────
group('A. здоровье песочницы (не зависит от фичи)');

const mjsFiles = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); }
    else if (e.name.endsWith('.mjs')) mjsFiles.push(p);
  }
})(path.join(REPO, 'scripts'));

check('A1 node --check всех scripts', mjsFiles.every((f) => run(process.execPath, ['--check', f]).code === 0),
  `${mjsFiles.length} файлов`);

// Фикстуры должны быть реально сломанными, иначе «контролируемое падение» ничего не проверяет.
check('A2 fixture broken-docs: ссылка действительно битая',
  !fs.existsSync(path.join(FX, 'broken-docs', 'missing-target.md')));
check('A2 fixture broken-docs: JSON действительно невалиден',
  readJson(path.join(FX, 'broken-docs', 'data.json')) === null);
check('A2 fixture node-broken: check действительно падает',
  run(process.execPath, ['check.js'], { cwd: path.join(FX, 'node-broken') }).code === 1);
check('A2 fixture node-clean: check действительно зелёный',
  run(process.execPath, ['check.js'], { cwd: path.join(FX, 'node-clean') }).code === 0);
check('A2 endpoint песочницы — локальный bare-репозиторий, без ssh-алиаса',
  fs.existsSync(path.join(ENDPOINT, 'HEAD')) && fs.existsSync(path.join(ENDPOINT, 'config')));
check('A2 fakebin без gh/npm (dry-run физически не может создать Issue)',
  !fs.existsSync(path.join(RUN, 'fakebin', 'gh')) && !fs.existsSync(path.join(RUN, 'fakebin', 'npm')));

// Фикстуры и манифест не должны содержать значений секретов (AC-07/AC-08).
let fixtureSecretHit = null;
(function scanFixtures(d) {
  if (fixtureSecretHit) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (fixtureSecretHit) return;
    const p = path.join(d, e.name);
    if (e.isDirectory()) scanFixtures(p);
    else if (looksLikeSecretValue(fs.readFileSync(p, 'utf8'))) fixtureSecretHit = path.relative(RUN, p);
  }
})(FX);
check('A3 в фикстурах нет значений секретов', fixtureSecretHit === null, fixtureSecretHit || 'чисто');

// ── B. Сценарий через CLI (падает, пока фичи нет) ─────────────────────────────
group('B. сценарий через внешний контракт CLI');

if (!fs.existsSync(CLI)) {
  // Корень один, чтобы падение читалось как «фичи ещё нет», а не как 20 отдельных багов.
  fail('B0 CLI scripts/devbaseline.mjs существует', 'фича не реализована (срезы T1–T8)');
  for (const [step, owner] of [
    ['S1 inventory', 'T6'], ['S2 docs-only без build', 'T1+T4'], ['S3 construction-tasks dry-run', 'T6'],
    ['S4 context fresh/stale/missing', 'T8'], ['S6 controlled failure / no_change / needs_human', 'T4+T5'],
    ['S7 log-контракт AC-44', 'T2+T4'],
  ]) fail(`${step}`, `blocked_by: cli_missing (${owner})`);
} else {
  ok('B0 CLI scripts/devbaseline.mjs существует');

  // ── S1: инвентаризация ──────────────────────────────────────────────────────
  const s1 = cli(['inventory', '--repos', REPOS_FILE, '--out', OUT], { cleanPath: true });
  check('S1 inventory: код 0 на доступном наборе', s1.code === 0, `code=${s1.code}${s1.code !== 0 ? ` · ${s1.out.trim().split('\n').slice(-2).join(' | ').slice(0, 200)}` : ''}`);
  const covJson = path.join(OUT, 'repo-coverage.json');
  const covMd = path.join(OUT, 'repo-coverage.md');
  const cov = readJson(covJson);
  check('S1 inventory: repo-coverage.json записан', cov !== null);
  check('S1 inventory: repo-coverage.md записан', fs.existsSync(covMd));
  const rows = Array.isArray(cov) ? cov : (cov?.repos || cov?.rows || []);
  check('S1 inventory: строка на каждый репозиторий', rows.length === 4, `rows=${rows.length}`);
  for (const col of ['repo', 'type', 'profile', 'adapter', 'check', 'fix', 'verify', 'context', 'logs',
    'ci_present', 'ci_required', 'staging_present', 'staging_required', 'readable', 'profile_ref']) {
    check(`S1 колонка ${col} есть (AC-40)`, rows.length > 0 && rows.every((r) => Object.hasOwn(r, col)));
  }
  const docRow = rows.find((r) => /docs-only/.test(r.repo || ''));
  const brokenRow = rows.find((r) => /node-broken/.test(r.repo || ''));
  const unreadRow = rows.find((r) => /unreadable/.test(r.repo || ''));
  check('S1 docs-only получает профиль docs', docRow?.profile === 'docs', `profile=${docRow?.profile}`);
  check('S1 node-репо получает профиль node', brokenRow?.profile === 'node', `profile=${brokenRow?.profile}`);
  check('S1 adapter помечен derived|file', ['derived', 'file'].includes(docRow?.adapter), `adapter=${docRow?.adapter}`);
  check('S1 недоступный репозиторий → readable:false', unreadRow?.readable === false, `readable=${unreadRow?.readable}`);
  check('S1 недоступный репозиторий даёт код 4', s1.code === 4 || unreadRow?.readable === false, `code=${s1.code}`);

  // ── S2: docs-only не запускает build ────────────────────────────────────────
  const docsDir = path.join(FX, 'docs-only');
  const before = fs.existsSync(path.join(docsDir, 'node_modules')) || fs.existsSync(path.join(docsDir, 'package-lock.json'));
  const s2 = cli(['verify', '--repo', docsDir, '--profile', 'docs', '--log', path.join(OUT, 's2-docs.json')], { cleanPath: true });
  check('S2 docs-профиль: verify не падает', s2.code === 0 || s2.code === 2, `code=${s2.code}`);
  const after = fs.existsSync(path.join(docsDir, 'node_modules')) || fs.existsSync(path.join(docsDir, 'package-lock.json'));
  check('S2 docs-профиль: сборка не запускалась (нет node_modules/lock)', !before && !after);
  const s2row = rows.find((r) => r.repo === 'sandbox/docs-only');
  check('S2 в таблице build:false для docs-репо', s2row?.build === false || /false/i.test(String(s2row?.build)), `build=${s2row?.build}`);

  // ── S3: construction-tasks dry-run, Issue не создаётся ──────────────────────
  const tasks = path.join(OUT, 'construction-tasks.md');
  check('S3 construction-tasks.md сформирован', fs.existsSync(tasks));
  const tasksText = fs.existsSync(tasks) ? fs.readFileSync(tasks, 'utf8') : '';
  check('S3 missing-методы перечислены как construction tasks',
    /missing/i.test(tasksText) && (/unreadable/i.test(tasksText) || /staging/i.test(tasksText)));
  // PATH без gh: если бы dry-run был не dry-run, он бы упал, а не «успешно» ничего не сделал.
  check('S3 dry-run пережил запуск без gh в PATH (Issue не создавался)', s1.code === 0 || s1.code === 4, `code=${s1.code}`);

  // ── S4: три состояния контекста; stale не отдаётся как fresh ────────────────
  const ctxDir = path.join(FX, 'ctx-repo');
  const s4f = cli(['context', '--manifest', path.join(ctxDir, '.devbaseline-context.json')]);
  const s4s = cli(['context', '--manifest', path.join(ctxDir, '.devbaseline-context.stale.json')]);
  const s4m = cli(['context', '--manifest', path.join(ctxDir, '.devbaseline-context.absent.json')]);
  check('S4 context fresh → 0', s4f.code === 0, `code=${s4f.code}`);
  check('S4 context stale → 2', s4s.code === 2, `code=${s4s.code}`);
  check('S4 context missing → 3', s4m.code === 3, `code=${s4m.code}`);
  check('S4 stale не помечен как fresh', !/\bfresh\b/i.test(s4s.out) || /stale/i.test(s4s.out), s4s.out.trim().slice(0, 120));

  // ── S6: контролируемое падение, no_change, needs_human ─────────────────────
  const logBroken = path.join(OUT, 's6-broken.json');
  const s6b = cli(['verify', '--repo', path.join(FX, 'node-broken'), '--log', logBroken]);
  check('S6 контролируемое падение → код 1', s6b.code === 1, `code=${s6b.code}`);
  const brokenLog = readJson(logBroken);
  check('S6 у отказа есть rule_id', typeof get(brokenLog, ['rule_id']) === 'string' && get(brokenLog, ['rule_id']).length > 0, `rule_id=${get(brokenLog, ['rule_id'])}`);
  check('S6 rule_id из фиксированного словаря', RULE_IDS.has(get(brokenLog, ['rule_id'])), `rule_id=${get(brokenLog, ['rule_id'])}`);
  check('S6 outcome=failed у контролируемого прогона', get(brokenLog, ['outcome']) === 'failed', `outcome=${get(brokenLog, ['outcome'])}`);

  const logClean = path.join(OUT, 's6-clean.json');
  const s6c = cli(['verify', '--repo', path.join(FX, 'node-clean'), '--log', logClean]);
  check('S6 положительный путь → код 0', s6c.code === 0, `code=${s6c.code}`);

  const logRepeat = path.join(OUT, 's6-repeat.json');
  const s6r = cli(['verify', '--repo', path.join(FX, 'node-clean'), '--log', logRepeat]);
  const repeatLog = readJson(logRepeat);
  check('S6 повтор без изменений → код 0', s6r.code === 0, `code=${s6r.code}`);
  check('S6 повтор без изменений → outcome=no_change', repeatLog?.outcome === 'no_change', `outcome=${repeatLog?.outcome}`);
  check('S6 no_change: patch_refs пуст', Array.isArray(repeatLog?.patch_refs) && repeatLog.patch_refs.length === 0, `patch_refs=${JSON.stringify(repeatLog?.patch_refs)}`);

  const logNoFixer = path.join(OUT, 's6-nofixer.json');
  const s6n = cli(['verify', '--repo', path.join(FX, 'no-fixer-app'), '--log', logNoFixer]);
  check('S6 чинить нечем → код 2 (needs_human)', s6n.code === 2, `code=${s6n.code}`);
  const noFixerLog = readJson(logNoFixer);
  check('S6 needs_human: outcome=needs_human', noFixerLog?.outcome === 'needs_human', `outcome=${noFixerLog?.outcome}`);
  check('S6 needs_human: reason_code из словаря',
    ['cap_exhausted', 'unsupported_by_profile'].includes(noFixerLog?.reason_code), `reason_code=${noFixerLog?.reason_code}`);

  const s6d = cli(['check-docs', '--dir', path.join(FX, 'broken-docs')]);
  check('S6 check-docs на битой документации → код 1', s6d.code === 1, `code=${s6d.code}`);
  check('S6 check-docs называет docs_link_broken', /docs_link_broken/.test(s6d.out), s6d.out.trim().slice(0, 160));
  check('S6 check-docs называет docs_json_invalid', /docs_json_invalid/.test(s6d.out));

  // ── S7: log-контракт AC-44 ─────────────────────────────────────────────────
  for (const [label, log] of [['failed', brokenLog], ['no_change', repeatLog], ['needs_human', noFixerLog]]) {
    if (!log) { fail(`S7 запись ${label} существует`, 'нет log-записи'); continue; }
    const missing = AC44_FIELDS.filter((keys) => get(log, keys) === undefined);
    check(`S7 ${label}: все поля AC-44 заполнены`, missing.length === 0,
      missing.length ? `нет: ${missing.map((m) => m.join('.')).join(', ')}` : 'полный набор');
  }
  check('S7 tool.name = pr-autofix', get(brokenLog, ['tool', 'name']) === 'pr-autofix', `tool.name=${get(brokenLog, ['tool', 'name'])}`);
  check('S7 budget заполнен числами',
    typeof get(brokenLog, ['budget', 'diff_tokens']) === 'number' && typeof get(brokenLog, ['budget', 'diff_tokens_used']) === 'number');
  check('S7 retention заполнен', typeof get(brokenLog, ['retention', 'ttl_days']) === 'number');
  check('S7 attempt_count заполнен', typeof get(brokenLog, ['attempt_count']) === 'number');
  check('S7 у failed нет patch_refs-обманки', Array.isArray(brokenLog?.patch_refs));
  check('S7 included/omitted paths — массивы',
    Array.isArray(brokenLog?.included_paths) && Array.isArray(brokenLog?.omitted_paths));
  const logSecret = [logBroken, logClean, logRepeat, logNoFixer]
    .filter((f) => fs.existsSync(f))
    .find((f) => looksLikeSecretValue(fs.readFileSync(f, 'utf8')));
  check('S7 в log-записях нет значений секретов (AC-07)', !logSecret, logSecret ? path.basename(logSecret) : 'чисто');

  // ── S7a: правда в записях, а не только форма ─────────────────────────────────
  // Записи проверяются на ПОЛНОТУ выше; здесь — на ДОСТОВЕРНОСТЬ. Ровно тот класс регрессии,
  // который проходит любую проверку формы: правдоподобный URL, собранный из run_id, и remote
  // окружающего репозитория, выданный за remote подкаталога.
  check('S7a patch_refs — ссылки на вызовы, не собранные URL',
    brokenLog?.patch_refs?.every(r => !/^https?:\/\//.test(r)), JSON.stringify(brokenLog?.patch_refs));
  check('S7a не-репозиторию не приписывается remote окружающего репозитория',
    get(brokenLog, ['source', 'repo']) === '', `repo=${JSON.stringify(get(brokenLog, ['source', 'repo']))}`);
  check('S7a коммиты не-репозитория остаются unknown, а не чужими',
    get(brokenLog, ['source', 'head_commit']) === 'unknown' && get(brokenLog, ['source', 'base_commit']) === 'unknown');
  check('S7a request_id детерминирован (без UUID и часов)',
    get(brokenLog, ['request', 'request_id']) === 'local:verify:1', `request_id=${get(brokenLog, ['request', 'request_id'])}`);
  check('S7a credentials — имена, без значений', Array.isArray(brokenLog?.credentials));

  // Путь записи без каталога (`--log bare.json`) обязан работать: mkdirSync('') падает.
  const bareDir = path.join(OUT, 'bare-log');
  fs.mkdirSync(bareDir, { recursive: true });
  const bare = run(process.execPath, [CLI, 'verify', '--repo', path.join(FX, 'node-clean'), '--log', 'bare.json'], { cwd: bareDir });
  check('S7a --log без каталога пишет запись (mkdir не спотыкается)',
    bare.code === 0 && fs.existsSync(path.join(bareDir, 'bare.json')), `code=${bare.code}`);
}

// ── C. Шаги в других репозиториях — не красные, но зафиксированы ──────────────
group('C. границы покрытия песочницы');
skip('S5 одна процедура setup→run→evidence→teardown', 'владелец software-engineering-playbooks, срез T10; endpoint песочницы (local bare repo) уже создан');
skip('S8 coverage-drift', 'владелец trained-agent-architecture, срез T11; генератор таблицы — срез T6');

// ── Итог ──────────────────────────────────────────────────────────────────────
const runManifest = {
  sandbox: 'z01-devbaseline',
  level: 'S3',
  endpoint: `file://${ENDPOINT}`,
  endpoint_kind: 'local-bare-repo',
  ssh_alias_used: false,
  network: 'disabled-by-proxy-and-clean-path',
  profile_ref: null,
  ok: okCount, fail: failCount, skip: skipCount,
  failures,
};
fs.writeFileSync(path.join(OUT, 'sandbox-run.json'), JSON.stringify(runManifest, null, 2));

if (!KEEP) fs.rmSync(path.join(RUN, 'fixtures'), { recursive: true, force: true });
console.log(`\nартефакты прогона: ${path.relative(REPO, OUT)}${KEEP ? ' (фикстуры сохранены)' : ''}`);
console.log(`SANDBOX z01 — ok: ${okCount}, FAIL: ${failCount}, skip: ${skipCount}`);
if (failCount) {
  for (const f of failures) console.log(`  · ${f}`);
  console.log(`SANDBOX z01 FAIL (уровень S3)`);
  process.exit(1);
}
console.log('SANDBOX z01 PASS (уровень S3)');
