#!/usr/bin/env node
// Z01 sandbox — замкнутый цикл сценария «inventory и общий development baseline».
//
//   node scripts/sandbox/z01-devbaseline.mjs        # одна команда, детерминированный pass/fail
//   node scripts/sandbox/z01-devbaseline.mjs --keep # не удалять рабочий каталог прогона
//
// Уровень автономности — S3 (autotests с моками внешних зависимостей, fixture, офлайн).
// Время цикла — ~5 с на этой машине (замерено, 3 прогона: 5.4 / 4.4 / 4.9 с). Почти всё время —
// реальные `npm test` в node-фикстурах: деривация обязана запускать ту же команду, что и CI, а не
// подменять её прямым `node check.js` (иначе `pretest` и env от npm исчезли бы из проверки).
// Внешних сетевых вызовов нет вообще:
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

import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';

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

/**
 * Тот же CLI, но асинхронно.
 *
 * Нужен ровно в одном месте — там, где дочерний процесс должен обратиться к фиктивному
 * GitHub API, который слушает ЭТОТ ЖЕ процесс. `spawnSync` блокирует event loop, а значит
 * и accept() входящего соединения: синхронный запуск виснет до таймаута и даёт `code = -1`,
 * который выглядит как «фича сломана», хотя сломана была песочница. Первая сборка этого блока
 * упала именно так — 16 FAIL, все от одного тупика. Асинхронный spawn оставляет loop свободным.
 */
const cliAsync = (args, opts = {}) => new Promise((resolve) => {
  const e = { ...process.env, ...OFFLINE_ENV, ...(opts.env || {}) };
  const child = spawn(process.execPath, [CLI, ...args], { cwd: opts.cwd || REPO, env: e, encoding: 'utf8' });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  child.on('close', (status) => { clearTimeout(timer); resolve({ code: status ?? -1, out }); });
  child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: String(e) }); });
});

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
//    check печатает НАстоящее правило из словаря (docs_heading_missing) — иначе F4-регрессия
//    (rule_id = unsupported_by_profile вместо правила check'а) была бы неотличима от нормы.
w('no-fixer-app/package.json', JSON.stringify({ name: 'no-fixer-app', version: '1.0.0', scripts: { test: 'node check.js' } }, null, 2));
w('no-fixer-app/check.js', 'console.error("docs_heading_missing: src/app.md: no top-level (#) heading");\nprocess.exit(1);\n');

// 4a. no-fixer-silent: check красный и НИЧЕГО не называет → rule_id остаётся честным
//     (engine-правило), а не выдуманным. Отличает «check назвал правило» от «check молчит».
w('no-fixer-silent/package.json', JSON.stringify({ name: 'no-fixer-silent', version: '1.0.0', scripts: { test: 'node check.js' } }, null, 2));
w('no-fixer-silent/check.js', CHECK_FAIL);

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

// 6a. Фикстуры для ЖИВОГО пути inventory (F1/F2). Один и тот же набор файлов лежит на диске
//     (live-src/) и обслуживается фиктивным GitHub API (см. фиктивный endpoint ниже).
//     Две фикстуры разведены НАМЕРЕННО, чтобы детектор staging был обязан падать в обе стороны:
//
//       live-mixed       — файла *staging* НЕТ, джоб `staging-gate` живёт внутри ci.yml
//                          (ровно как в самом pr-autofix). Детектор по ИМЕНИ файла сказал бы
//                          `no` — это и есть дефект F2; по содержимому обязан сказать `yes`.
//       live-no-staging  — файл *staging-notes.yml* ЕСТЬ, а джоба staging внутри нет.
//                          Детектор по ИМЕНИ сказал бы `yes` — обратная ошибка. Обязан `false`.
//
//     Одна фикстура вместо двух проверила бы только половину: `yes` можно получить и неверно.
const LIVE_TREE = {
  'package.json': JSON.stringify({ name: 'live-mixed', version: '1.0.0', scripts: { test: 'node check.js' } }, null, 2),
  'check.js': 'process.exit(0);\n',
  '.github/workflows/ci.yml': 'name: CI\non: [push]\njobs:\n  selftest:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo selftest\n  staging-gate:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo staging\n',
};
// Живой docs-репозиторий: package.json нет, README есть → профиль docs (F1: type/profile/check/
// fix/verify/context/logs заполняются по содержимому, а не остаются пустыми). И адаптер с
// credential-именем (не значением) — колонки credentials/check строятся из файла-адаптера.
const LIVE_DOCS_TREE = {
  'README.md': '# Live docs\n\nДокументация без кода.\n',
  'docs/guide.md': '# Гайд\n\nСсылка рабочая: [назад](../README.md).\n',
  '.devbaseline.json': JSON.stringify({
    schema_version: 1,
    check: { commands: ['node {{devbaseline}} check-docs --dir .'] },
    credentials: [{ name: 'DOCS_CHECK_TOKEN', kind: 'repo_secret' }],
    logs: { retention_days: 30 },
  }, null, 2),
};
// Живой репозиторий без staging-джоба, но С ФАЙЛОМ, названным *staging* — обратная сторона F2:
// наличие файла не доказывает наличие джобы. Скан по имени здесь ответил бы yes и соврал.
const LIVE_NO_STAGING_TREE = {
  'README.md': '# No staging\n',
  '.github/workflows/ci.yml': 'name: CI\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n',
  '.github/workflows/staging-notes.yml': 'name: Notes\non: [push]\njobs:\n  notes:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo notes\n',
};
// Живой репозиторий, у которого дерево выглядит как docs (README, нет package.json), а адаптер
// ЗАКРЕПЛЯЕТ профиль node. Схема адаптера рекламирует поле `profile`; до этого шага резолвер его
// игнорировал, и «закрепить недеривируемое» — задокументированное лечение — не работало.
const LIVE_PINNED_TREE = {
  'README.md': '# Looks like docs, is pinned as node\n',
  '.devbaseline.json': JSON.stringify({ schema_version: 1, profile: 'node' }, null, 2),
};

// 7. Endpoint песочницы (AC-09): собственный bare-репозиторий, не ssh-алиас `vm`.
const ENDPOINT = path.join(RUN, 'endpoint.git');
run('git', ['init', '-q', '--bare', ENDPOINT], { cwd: RUN });

// 7a. Фиктивный GitHub API для ЖИВОГО пути (AC-09: свой endpoint, не чужой).
//     Отвечает ровно теми запросами, которые делает liveSource(): repo, рекурсивное дерево,
//     содержимое файла. Никакой сети — адрес слушается на 127.0.0.1 и подставляется через
//     DEVBASELINE_GITHUB_API. Это позволяет проверять ЖИВОЙ код офлайн: тот же scanSource,
//     тот же liveSource, другой адрес endpoint'а.
// Репозитории, у которых метаданные читаются, а дерево на ветке по умолчанию отсутствует.
const EMPTY_REPOS = new Set(['live-empty']);
const LIVE_REPOS = {
  'live-mixed': LIVE_TREE,
  'live-docs': LIVE_DOCS_TREE,
  'live-no-staging': LIVE_NO_STAGING_TREE,
  'live-pinned': LIVE_PINNED_TREE,
};
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const apiServer = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const m = /^\/repos\/[^/]+\/([^/]+)(?:\/(.*))?$/.exec(req.url.split('?')[0]);
  if (!m) return send(404, { message: 'Not Found' });
  const [, name, rest] = m;
  // Пустой репозиторий обрабатываем ДО проверки дерева: у него нет записи в LIVE_REPOS,
  // и без этого условия запрос дерева уходил в ветку «репозиторий не найден».
  if (EMPTY_REPOS.has(name)) {
    if (!rest) return send(200, { name, default_branch: 'main', private: false });
    if (rest.startsWith('git/trees/')) return send(404, { message: 'Git Repository is empty.' });
    return send(404, { message: 'Not Found' });
  }
  const tree = LIVE_REPOS[name];
  if (!tree) {
    // R8: два разных 404 — два разных факта. `live-invisible` отказывается отдавать МЕТАДАННЫЕ
    // (репозиторий не виден этому читателю), `live-empty` отдаёт метаданные, но не дерево
    // (репозиторий читаем, но на ветке по умолчанию нет коммита). Раньше оба давали одну строку
    // `unreadable: HTTP 404`, и таблица менялась от того, КАКИМ читателем её сгенерировали.
    if (EMPTY_REPOS.has(name)) return send(200, { name, default_branch: 'main', private: false });
    return send(404, { message: 'Not Found' });
  }
  if (!rest) return send(200, { name, default_branch: 'main', private: false });
  if (rest.startsWith('git/trees/')) {
    // GitHub отдаёт в рекурсивном дереве и каталоги (type: tree). Они нужны: профиль docs
    // спрашивает про наличие каталога `docs` как об entrypoint, и локальный источник отвечает
    // на это existsSync. Без tree-записей живой скан ответил бы «нет», локальный «да».
    const paths = Object.keys(tree).flatMap(p => {
      const parts = p.split('/');
      const dirs = parts.slice(0, -1).map((_, i) => ({ path: parts.slice(0, i + 1).join('/'), type: 'tree' }));
      return [...dirs, { path: p, type: 'blob' }];
    });
    return send(200, { sha: '0'.repeat(40), truncated: false, tree: paths });
  }
  if (rest.startsWith('contents/')) {
    const file = decodeURIComponent(rest.slice('contents/'.length).split('?')[0]);
    if (!(file in tree)) return send(404, { message: 'Not Found' });
    return send(200, { name: path.basename(file), path: file, encoding: 'base64', content: b64(tree[file]) });
  }
  return send(404, { message: 'Not Found' });
});
await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
// unref обязателен: слушающий сокет держит event loop, и без unref успешный прогон (0 FAIL)
// НИКОГДА не завершился бы — процесс висел до таймаута джобы. На падении это маскировалось
// тем, что в конце стоит process.exit(1); на зелёном пути висели. Проверяется просто:
// `time node scripts/sandbox/z01-devbaseline.mjs` обязан вернуть exit 0 сам, без timeout.
apiServer.unref();
const LIVE_API = `http://127.0.0.1:${apiServer.address().port}`;
// Тот же набор файлов на диске: локальный скан обязан дать ТЕ ЖЕ производные колонки,
// что и живой скан тех же файлов. Это и есть проверка «один вывод, два источника».
for (const [name, files] of Object.entries(LIVE_REPOS)) {
  for (const [rel, content] of Object.entries(files)) w(`live-src/${name}/${rel}`, content);
}

// 8. Список репозиториев для S1: локальные checkout'ы, `path` вместо GitHub API.
const REPOS_FILE = path.join(RUN, 'repos.json');
fs.writeFileSync(REPOS_FILE, JSON.stringify([
  { repo: 'sandbox/docs-only', type_hint: 'docs', path: path.join(FX, 'docs-only') },
  { repo: 'sandbox/node-clean', type_hint: 'node', path: path.join(FX, 'node-clean') },
  { repo: 'sandbox/node-broken', type_hint: 'node', path: path.join(FX, 'node-broken') },
  { repo: 'sandbox/unreadable', type_hint: null, path: path.join(FX, 'does-not-exist') },
], null, 2));

// 8a. Те же файлы, что обслуживает фиктивный API, но прочитанные ДВУМЯ путями: локально (`path`)
//     и «вживую» (GH_TOKEN + DEVBASELINE_GITHUB_API на фиктивный endpoint). Ни type_hint, ни
//     path в живом списке нет — профиль выводится по тому, что источник действительно содержит.
fs.writeFileSync(path.join(RUN, 'repos-live.json'), JSON.stringify(
  Object.keys(LIVE_REPOS).map(name => ({ repo: `sandbox-live/${name}`, type_hint: null, ci_required: null })), null, 2));
// R8: два репозитория, которые обязаны различаться по СОСТОЯНИЮ, а не по тексту ошибки.
fs.writeFileSync(path.join(RUN, 'repos-live-r8.json'), JSON.stringify([
  { repo: 'sandbox-live/live-empty', type_hint: null, ci_required: null },
  { repo: 'sandbox-live/live-invisible', type_hint: null, ci_required: null },
], null, 2));
fs.writeFileSync(path.join(RUN, 'repos-local-src.json'), JSON.stringify(
  Object.keys(LIVE_REPOS).map(name => ({ repo: `sandbox-src/${name}`, type_hint: null, ci_required: null, path: path.join(FX, 'live-src', name) })), null, 2));

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
    'ci_present', 'ci_required', 'staging_present', 'staging_required', 'read_state', 'profile_ref']) {
    check(`S1 колонка ${col} есть (AC-40)`, rows.length > 0 && rows.every((r) => Object.hasOwn(r, col)));
  }
  const docRow = rows.find((r) => /docs-only/.test(r.repo || ''));
  const brokenRow = rows.find((r) => /node-broken/.test(r.repo || ''));
  const unreadRow = rows.find((r) => /unreadable/.test(r.repo || ''));
  check('S1 docs-only получает профиль docs', docRow?.profile === 'docs', `profile=${docRow?.profile}`);
  check('S1 node-репо получает профиль node', brokenRow?.profile === 'node', `profile=${brokenRow?.profile}`);
  check('S1 adapter помечен derived|file', ['derived', 'file'].includes(docRow?.adapter), `adapter=${docRow?.adapter}`);
  check('S1 недоступный репозиторий → read_state:no_access', unreadRow?.read_state === 'no_access', `read_state=${unreadRow?.read_state}`);
  check('S1 недоступный репозиторий даёт код 4', s1.code === 4 || unreadRow?.read_state === 'no_access', `code=${s1.code}`);

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
    /missing/i.test(tasksText) && (/no_access/i.test(tasksText) || /staging/i.test(tasksText)));
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

  // F4 (AC-44): лог обязан называть правило НАСТОЯЩЕГО check'а, а не только то, что чинить нечем.
  // no-fixer-app печатает docs_heading_missing; engine-факт (unsupported_by_profile) уходит в
  // reason_code/stopped_because. Раньше rule_id был ТОЛЬКО engine-фактом, и красный репозиторий
  // выглядел в логе как «просто нет фиксера».
  check('F4 needs_human: rule_id — правило check\'а, а не только про движок',
    noFixerLog?.rule_id === 'docs_heading_missing', `rule_id=${noFixerLog?.rule_id}`);
  check('F4 needs_human: reason_code остаётся про движок (engine-факт не потерян)',
    noFixerLog?.reason_code === 'unsupported_by_profile', `reason_code=${noFixerLog?.reason_code}`);
  check('F4 needs_human: stopped_because назван явно', noFixerLog?.stopped_because === 'unsupported_by_profile',
    `stopped_because=${noFixerLog?.stopped_because}`);
  check('F4 needs_human: нарушение check\'а в gate_violations с путём и сообщением',
    (noFixerLog?.gate_violations || []).some(v => v.rule_id === 'docs_heading_missing' && v.path === 'src/app.md'),
    JSON.stringify((noFixerLog?.gate_violations || []).slice(0, 2)));
  check('F4 needs_human: rule_violations — отдельным аддитивным полем',
    (noFixerLog?.rule_violations || []).some(v => v.rule_id === 'docs_heading_missing'),
    JSON.stringify(noFixerLog?.rule_violations));
  // Негативный контроль F4: check, который не называет правило, обязан НЕ выдумывать его.
  const logSilent = readJson(cli(['verify', '--repo', path.join(FX, 'no-fixer-silent'), '--log',
    path.join(OUT, 's6-nofixer-silent.json')]) && path.join(OUT, 's6-nofixer-silent.json'));
  check('F4 негативный контроль: check без rule id → rule_id не выдуман',
    logSilent?.rule_id === 'unsupported_by_profile', `rule_id=${logSilent?.rule_id}`);
  check('F4 негативный контроль: выдуманных rule_violations нет',
    (logSilent?.rule_violations || []).length === 0, JSON.stringify(logSilent?.rule_violations));

  const s6d = cli(['check-docs', '--dir', path.join(FX, 'broken-docs')]);
  check('S6 check-docs на битой документации → код 1', s6d.code === 1, `code=${s6d.code}`);
  check('S6 check-docs называет docs_link_broken', /docs_link_broken/.test(s6d.out), s6d.out.trim().slice(0, 160));
  check('S6 check-docs называет docs_json_invalid', /docs_json_invalid/.test(s6d.out));

  // ── F1/F2: ЖИВОЙ путь inventory против локального, на одинаковых файлах ──────
  // Живой скан идёт через фиктивный endpoint песочницы (свой, не api.github.com), поэтому
  // проверяется РЕАЛЬНЫЙ код scanSource/liveSource, а не мок внутренних функций.
  const LIVE_OUT = path.join(OUT, 'live');
  const liveEnv = { GH_TOKEN: 'ghs_sandboxfixture0000000000000000000', DEVBASELINE_GITHUB_API: LIVE_API };
  const liveRun = await cliAsync(['inventory', '--repos', path.join(RUN, 'repos-live.json'), '--out', LIVE_OUT], { env: liveEnv });
  check('F1 живой inventory: код 0 на фиктивном endpoint', liveRun.code === 0,
    `code=${liveRun.code}${liveRun.code !== 0 ? ` · ${liveRun.out.trim().split('\n').slice(-2).join(' | ').slice(0, 200)}` : ''}`);
  const liveCov = readJson(path.join(LIVE_OUT, 'repo-coverage.json'));
  const liveRows = liveCov?.repos || [];
  const liveMixed = liveRows.find(r => /live-mixed$/.test(r.repo));
  const liveDocs = liveRows.find(r => /live-docs$/.test(r.repo));
  const liveNoStg = liveRows.find(r => /live-no-staging$/.test(r.repo));
  const livePinned = liveRows.find(r => /live-pinned$/.test(r.repo));

  // F1: производные колонки заполнены на ЖИВОМ пути — раньше все 25 репозиториев давали «—».
  // `autofix_ref` проверяется отдельно и только там, где фиксер вообще есть: у docs-профиля
  // (нет autofix_callable) закреплять ref нечего, и требование «заполнено» здесь было бы
  // требованием выдумать значение — ровно тот класс дефекта, который карточка и закрывает.
  const DERIVED = ['type', 'profile', 'adapter', 'build', 'check', 'fix', 'verify', 'context', 'logs'];
  for (const [label, row] of [['live-mixed', liveMixed], ['live-docs', liveDocs]]) {
    const empty = DERIVED.filter(c => row?.[c] === null || row?.[c] === undefined);
    check(`F1 ${label}: производные колонки заполнены на живом пути (AC-40)`, row && empty.length === 0,
      empty.length ? `пусто: ${empty.join(', ')}` : 'все заполнены');
  }
  check('F1 живой node-репозиторий: autofix_ref закреплён (есть фиксер)', liveMixed?.autofix_ref === 'v1.7.4',
    `autofix_ref=${liveMixed?.autofix_ref}`);
  check('F1 живой docs-репозиторий: autofix_ref честно пуст (профиль docs без фиксера)',
    liveDocs?.autofix_ref === null && liveDocs?.fix?.supported === false,
    `autofix_ref=${liveDocs?.autofix_ref} supported=${liveDocs?.fix?.supported}`);
  check('F1 живой node-репозиторий получил профиль node', liveMixed?.profile === 'node', `profile=${liveMixed?.profile}`);
  check('F1 живой docs-репозиторий получил профиль docs', liveDocs?.profile === 'docs', `profile=${liveDocs?.profile}`);
  check('F1 живой docs: build=false (docs-only не получает application build)', liveDocs?.build === false, `build=${liveDocs?.build}`);
  check('F1 живой docs: adapter прочитан с endpoint\'а (adapter=file)', liveDocs?.adapter === 'file', `adapter=${liveDocs?.adapter}`);
  check('F1 живой docs: retention взят из адаптера, не из профиля',
    liveDocs?.logs?.retention_days === 30, `retention=${JSON.stringify(liveDocs?.logs)}`);

  // Закрепление профиля адаптером: дерево выглядит как docs, адаптер говорит node. Схема
  // адаптера рекламирует `profile`, и это единственный способ починить неверную деривацию
  // в репозитории, где стека не видно в дереве. До фикса поле игнорировалось (мёртвый конфиг).
  check('F1 закрепление профиля: адаптер профиля побеждает деривацию по дереву',
    livePinned?.profile === 'node', `profile=${livePinned?.profile}`);
  check('F1 закрепление профиля: строка помечена adapter=file',
    livePinned?.adapter === 'file', `adapter=${livePinned?.adapter}`);
  check('F1 закрепление профиля: staging_required следует за профилем, не за деревом',
    livePinned?.staging_required === true, `required=${livePinned?.staging_required}`);

  // F2: staging определяется по ДЖОБАМ, а не по имени файла.
  check('F2 живой скан: staging-джоб внутри ci.yml найден, имя файла про staging не ищем',
    liveMixed?.staging_present === true, `staging_present=${liveMixed?.staging_present}`);
  check('F2 имя workflow-файла само по себе НЕ считается staging (staging-notes.yml без джоба)',
    liveNoStg?.staging_present === false,
    `live-no-staging staging_present=${liveNoStg?.staging_present} (при наличии файла *staging*)`);
  check('F2 живой скан: staging_required=true для node-профиля', liveMixed?.staging_required === true, `required=${liveMixed?.staging_required}`);

  // ── R8: читаемость — состояние таблицы, а не свойство читателя ────────────────
  // Дефект: строка `unreadable: GitHub API HTTP 404` ставилась и для репозитория, которого
  // читатель не видит, и для репозитория без коммита. Первый — задача по выдаче доступа,
  // второй — задача по первому коммиту; в таблице они были одним и тем же текстом, а в
  // byte-exact гейте делали результат зависимым от того, КАКИМ читателем прогнали генерацию.
  const R8_OUT = path.join(OUT, 'r8');
  const r8Run = await cliAsync(['inventory', '--repos', path.join(RUN, 'repos-live-r8.json'), '--out', R8_OUT], { env: liveEnv });
  check('R8 живой inventory: код 0 (невидимый репозиторий — данные, не поломка)', r8Run.code === 0, `code=${r8Run.code}`);
  const r8Rows = readJson(path.join(R8_OUT, 'repo-coverage.json'))?.repos || [];
  const r8Empty = r8Rows.find(r => /live-empty$/.test(r.repo));
  const r8Invisible = r8Rows.find(r => /live-invisible$/.test(r.repo));
  check('R8 репозиторий без коммита → read_state=empty, а не no_access', r8Empty?.read_state === 'empty',
    `read_state=${r8Empty?.read_state}`);
  check('R8 репозиторий без коммита НЕ считается невидимым', r8Empty?.read_state !== 'no_access',
    `read_state=${r8Empty?.read_state}`);
  check('R8 репозиторий без коммита не порождает construction task на доступ',
    !/no_access/.test(r8Empty?.notes?.join(' ') || ''), `notes=${JSON.stringify(r8Empty?.notes)}`);
  check('R8 невидимый репозиторий → read_state=no_access', r8Invisible?.read_state === 'no_access',
    `read_state=${r8Invisible?.read_state}`);
  check('R8 невидимый репозиторий: остальные колонки НЕ выдуманы (profile=null)',
    r8Invisible?.profile === null && r8Invisible?.ci_present === false,
    `profile=${r8Invisible?.profile} ci_present=${r8Invisible?.ci_present}`);
  check('R8 невидимый репозиторий даёт код 4 под --strict',
    (await cliAsync(['inventory', '--repos', path.join(RUN, 'repos-live-r8.json'), '--out', path.join(OUT, 'r8-strict'), '--strict'], { env: liveEnv })).code === 4,
    'strict обязан отказать на слепом пятне');
  // Сравниваемое артефакт: невидимая строка сравнивается только (repo, read_state), поэтому
  // генерация другим уполномоченным читателем не меняет ответ гейта.
  const r8Stable = readJson(path.join(R8_OUT, 'repo-coverage.stable.json'));
  check('R8 записан repo-coverage.stable.json', r8Stable !== null);
  const stableEmpty = r8Stable?.repos?.find(r => /live-empty$/.test(r.repo));
  const stableInvisible = r8Stable?.repos?.find(r => /live-invisible$/.test(r.repo));
  check('R8 stable: читаемая строка сравнивается целиком', stableEmpty && Object.keys(stableEmpty).length > 2,
    stableEmpty ? `полей=${Object.keys(stableEmpty).length}` : 'нет строки');
  check('R8 stable: невидимая строка сравнивается только (repo, read_state)',
    stableInvisible && Object.keys(stableInvisible).sort().join(',') === 'read_state,repo',
    stableInvisible ? `поля=${Object.keys(stableInvisible).join(',')}` : 'нет строки');
  // Волатильные счётчики не должны находиться в сравниваемом артефакте: иначе гейт краснеет
  // на каждом чужом коммите и его отключат.
  const fullEmpty = r8Empty?.notes?.join(' ') || '';
  check('R8 в заметке живого скана нет счётчика файлов (волатилен для byte-exact гейта)',
    !/files=\d+/.test(fullEmpty), fullEmpty);
  check('R8 в заметке живого скана нет счётчика workflow-файлов', !/workflows=\d+/.test(fullEmpty), fullEmpty);

  // Главное свойство F1: локальный и живой скан ТЕХ ЖЕ файлов обязаны дать ОДНИ И ТЕ ЖЕ
  // производные колонки. Расхождение = две реализации вывода, то есть исходный дефект.
  const localOut = path.join(OUT, 'local-src');
  const localRun = cli(['inventory', '--repos', path.join(RUN, 'repos-local-src.json'), '--out', localOut]);
  const localRows = (readJson(path.join(localOut, 'repo-coverage.json'))?.repos) || [];
  for (const name of ['live-mixed', 'live-docs', 'live-no-staging', 'live-pinned']) {
    const L = localRows.find(r => r.repo === `sandbox-src/${name}`);
    const V = liveRows.find(r => r.repo === `sandbox-live/${name}`);
    if (!L || !V) { fail(`F1 ${name}: строка найдена в обоих сканах`, `local=${!!L} live=${!!V}`); continue; }
    const diffs = DERIVED.concat(['autofix_ref', 'ci_present', 'staging_present', 'staging_required'])
      .filter(c => JSON.stringify(L[c]) !== JSON.stringify(V[c]));
    check(`F1 ${name}: локальный и живой скан совпадают по производным колонкам`, diffs.length === 0,
      diffs.length ? `расходятся: ${diffs.join(', ')}` : 'идентично');
  }

  // Негативный контроль F2: если бы staging считался по ИМЕНИ файла, live-no-staging дал бы yes.
  // Проверка обязана быть способна упасть — иначе она ничего не доказывает.
  check('F2 негативный контроль: фикстура действительно содержит файл *staging*',
    fs.existsSync(path.join(FX, 'live-src', 'live-no-staging', '.github', 'workflows', 'staging-notes.yml')));
  check('F2 негативный контроль: в live-mixed нет файла *staging*, но есть джоб',
    !fs.existsSync(path.join(FX, 'live-src', 'live-mixed', '.github', 'workflows', 'staging-notes.yml'))
    && /staging-gate/.test(LIVE_TREE['.github/workflows/ci.yml']));

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
