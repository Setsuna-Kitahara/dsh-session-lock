/**
 * Offline harness for the host half: the `archive-inactive` route and the
 * lock ledger it refuses to ignore.
 *
 * Everything runs against a throwaway `$DSH_HOME` built in the system temp
 * directory, so this test is hermetic: it never reads or writes the real DSH
 * state, and it passes on a machine that has never run DSH. The mock workspace
 * registry records archive calls instead of persisting them.
 *
 *   node test/archive-inactive.test.mjs
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Days of "silence" that makes a fixture session a candidate. */
const NOW = Date.now();

// The host half resolves $DSH_HOME inside apply(), so the fixture must exist
// (and the variable must be set) before the module is imported.
const home = await mkdtemp(join(tmpdir(), 'dsh-session-lock-test-'));
process.env.DSH_HOME = home;

const { apply } = await import('../lib/index.js');

/** Write one file, creating its parent directories. */
async function put(relativePath, content, { ageDays } = {}) {
    const target = join(home, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
    if (ageDays !== undefined) {
        const stamp = (NOW - ageDays * DAY_MS) / 1000;
        await utimes(target, stamp, stamp);
    }
    return target;
}

/** Minimal inbound request: emits one body chunk, then `end`. */
class FakeRequest extends EventEmitter {
    constructor({ method = 'POST', headers = {}, body = '' } = {}) {
        super();
        this.method = method;
        this.headers = headers;
        queueMicrotask(() => {
            if (body !== '') this.emit('data', Buffer.from(body, 'utf8'));
            this.emit('end');
        });
    }
}

/** Minimal response capturing status and body. */
function fakeResponse() {
    const state = { status: null, headers: null, body: '' };
    return {
        state,
        writeHead(status, headers) { state.status = status; state.headers = headers; },
        end(body) { state.body = String(body ?? ''); },
    };
}

//#region fixture
// Two sessions old enough to be candidates, one of them locked; plus a fresh
// session, a session whose newest log artifact is fresh (it was written to a
// minute ago even though an older artifact sits next to it), one
// already-archived session, one directory that is not a session id at all,
// and one session directory with no log files.
await put('plugin-data/dsh-session-lock/locks.json', JSON.stringify({
    version: 1,
    locked: { 'locked-old': { at: '2026-01-01T00:00:00.000Z', note: 'keep me' } },
}, null, 2));
await put('sessions/proj-alpha/old-a/session.2026-01-01T00-00-00.jsonl', '{}\n', { ageDays: 30 });
await put('sessions/proj-alpha/old-c/session.2026-01-01T00-00-00.jsonl', '{}\n', { ageDays: 15 });
await put('sessions/proj-alpha/mixed-age/session.2026-01-01T00-00-00.jsonl', '{}\n', { ageDays: 10 });
await put('sessions/proj-alpha/mixed-age/session.2026-01-01T00-00-00.jsonl.zstd', 'x', { ageDays: 0.5 });
await put('sessions/proj-beta/locked-old/session.2026-01-01T00-00-00.jsonl', '{}\n', { ageDays: 30 });
await put('sessions/proj-beta/fresh/session.2026-01-01T00-00-00.jsonl', '{}\n', { ageDays: 0 });
await put('sessions/proj-beta/archived-old/session.2026-01-01T00-00-00.jsonl', '{}\n', { ageDays: 20 });
await put('sessions/proj-beta/not a session id/session.2026-01-01T00-00-00.jsonl', '{}\n', { ageDays: 20 });
await mkdir(join(home, 'sessions/proj-beta/empty-dir'), { recursive: true });
// A title cache entry, so the projection's title path is exercised too.
await put('storages/session_projcache/sessions/old-a.json',
    JSON.stringify({ record: { rows: { title: { val: 'Fixture session A' } } } }));
//#endregion

/** Collect every route the plugin registers. */
function mount(services) {
    const registered = new Map();
    const context = {
        logger: { warn: (message) => console.warn(`[plugin warn] ${message}`) },
        effect(callback) { callback(); return () => {}; },
        webServer: { register: (route) => { registered.set(route.path, route.handler); } },
        get: (name) => services[name],
    };
    apply(context);
    return registered;
}

/** Drive one route with JSON in/out. */
async function call(registered, path, body, { headers = {}, method = 'POST' } = {}) {
    const handler = registered.get(path);
    if (handler === undefined) throw new Error(`route not registered: ${path}`);
    const request = new FakeRequest({
        method,
        headers: { 'x-dsh-session-lock': '1', 'content-type': 'application/json', ...headers },
        body: body === undefined ? '' : JSON.stringify(body),
    });
    const response = fakeResponse();
    await handler(request, response);
    return { status: response.state.status, json: response.state.body === '' ? null : JSON.parse(response.state.body) };
}

const ROUTE = '/plugins/dsh-session-lock/archive-inactive';

const archiveCalls = [];
const liveIds = new Set();
const registered = mount({
    workspaceRegistry: {
        archivedSessionIds: ['archived-old'],
        list: () => [{
            id: 'ws-alpha',
            path: '/workspace/alpha',
            title: 'Alpha',
            sessionIds: ['old-a', 'old-b'],
        }],
        archiveSession: async (id) => { archiveCalls.push(id); },
    },
    sessions: { get: (id) => (liveIds.has(id) ? { id } : undefined) },
});

const failures = [];
const check = (label, condition, detail = '') => {
    if (condition) {
        console.log(`  ok   ${label}`);
    } else {
        failures.push(label);
        console.log(`  FAIL ${label} ${detail}`);
    }
};

console.log(`fixture DSH_HOME=${home}\n`);

console.log('dry run, days=3');
const dry = await call(registered, ROUTE, { days: 3, dryRun: true });
check('status 200', dry.status === 200, `got ${dry.status}`);
check('ok:true', dry.json?.ok === true);
check('no writes during a dry run', archiveCalls.length === 0);
check('two sessions are stale enough', dry.json.candidates.length === 2,
    JSON.stringify(dry.json.candidates.map((row) => row.id)));
check('the locked session is skipped', JSON.stringify(dry.json.skipped.locked) === JSON.stringify(['locked-old']),
    JSON.stringify(dry.json.skipped));
check('the archived session is skipped', JSON.stringify(dry.json.skipped.alreadyArchived) === JSON.stringify(['archived-old']),
    JSON.stringify(dry.json.skipped));
check('fresh sessions count as recent', dry.json.skipped.recent === 2, String(dry.json.skipped.recent));
check('a non-session directory is not scanned', dry.json.scanned === 6, String(dry.json.scanned));
check('the newest log artifact decides staleness',
    dry.json.skipped.recent === 2 && !dry.json.candidates.some((row) => row.id === 'mixed-age'),
    JSON.stringify(dry.json.candidates.map((row) => row.id)));
check('every candidate is older than the cutoff',
    dry.json.candidates.every((row) => new Date(row.lastModified).getTime() <= new Date(dry.json.cutoff).getTime()));
check('candidates are oldest first',
    JSON.stringify(dry.json.candidates.map((row) => row.id)) === JSON.stringify(['old-a', 'old-c']),
    JSON.stringify(dry.json.candidates.map((row) => row.id)));
check('the title cache is read', dry.json.candidates.find((row) => row.id === 'old-a')?.title === 'Fixture session A',
    JSON.stringify(dry.json.candidates));
check('workspace mapping comes from the registry list',
    dry.json.candidates.find((row) => row.id === 'old-a')?.workspaceId === 'ws-alpha' &&
    dry.json.candidates.find((row) => row.id === 'old-c')?.workspaceId === null,
    JSON.stringify(dry.json.candidates));
for (const row of dry.json.candidates) {
    console.log(`    - ${row.id}  ${row.lastModified}  workspace=${row.workspaceId ?? '(none)'}  title=${row.title ?? '(no title)'}`);
}

console.log('\ndry run with one candidate marked live');
liveIds.add('old-c');
const dryLive = await call(registered, ROUTE, { days: 3, dryRun: true });
check('the live session moved to skipped.live', JSON.stringify(dryLive.json.skipped.live) === JSON.stringify(['old-c']),
    JSON.stringify(dryLive.json.skipped.live));
check('the live session is no longer a candidate',
    !dryLive.json.candidates.some((row) => row.id === 'old-c'));

console.log('\nreal run, days=3 (the mock registry records the calls)');
const full = await call(registered, ROUTE, { days: 3 });
check('status 200', full.status === 200, `got ${full.status}`);
check('archived == remaining candidates',
    full.json.archived.length === dryLive.json.candidates.length,
    `${full.json.archived?.length} vs ${dryLive.json.candidates.length}`);
check('no locked session was archived', full.json.archived.every((row) => row.id !== 'locked-old'));
check('no live session was archived', full.json.archived.every((row) => !liveIds.has(row.id)));
check('nothing failed', full.json.failed.length === 0, JSON.stringify(full.json.failed));
check('archived ids match the registry calls',
    JSON.stringify(archiveCalls) === JSON.stringify(full.json.archived.map((row) => row.id)));

console.log('\nlock ledger writes');
const setRoute = registered.get('/plugins/dsh-session-lock/set');
const healthRoute = registered.get('/plugins/dsh-session-lock/health');
const locked = await call(registered, '/plugins/dsh-session-lock/set', { sessionId: 'old-a', locked: true, note: '  hold  ' });
check('set returns the new lock', locked.status === 200 && locked.json.locked.includes('old-a'), JSON.stringify(locked.json));
check('an absurd id is rejected',
    (await call(registered, '/plugins/dsh-session-lock/set', { sessionId: 'not a session id', locked: true })).status === 400);
const health = await call(registered, '/plugins/dsh-session-lock/health', undefined, { method: 'GET' });
check('the ledger landed on disk at the fixture path',
    health.json.path === join(home, 'plugin-data', 'dsh-session-lock', 'locks.json'), health.json.path);
check('the ledger counts both locks', health.json.count === 2, JSON.stringify(health.json));
const unlocked = await call(registered, '/plugins/dsh-session-lock/set', { sessionId: 'old-a', locked: false });
check('unlock drops it again', unlocked.json.locked.length === 1, JSON.stringify(unlocked.json.locked));
await call(registered, '/plugins/dsh-session-lock/unlock-all', {});
check('unlock-all empties the ledger',
    (await call(registered, '/plugins/dsh-session-lock/health', undefined, { method: 'GET' })).json.count === 0);
check('routes are mounted where the browser half expects them',
    setRoute !== undefined && healthRoute !== undefined && registered.size === 5, String(registered.size));

console.log('\nvalidation');
check('absurd days rejected', (await call(registered, ROUTE, { days: 99999 })).status === 400);
check('non-numeric days rejected', (await call(registered, ROUTE, { days: 'soon' })).status === 400);
check('missing guard header rejected',
    (await call(registered, ROUTE, { days: 3 }, { headers: { 'x-dsh-session-lock': '0' } })).status === 403);
const sameDay = await call(registered, ROUTE, { days: 0, dryRun: true });
check('days=0 widens the candidate set, never narrows it',
    sameDay.json.candidates.length >= dry.json.candidates.length,
    `${sameDay.json.candidates.length} vs ${dry.json.candidates.length}`);
const whitelist = await call(registered, ROUTE, { days: 3, dryRun: true, sessionIds: ['old-a'] });
check('a sessionIds whitelist narrows the scan',
    JSON.stringify(whitelist.json.candidates.map((row) => row.id)) === JSON.stringify(['old-a']),
    JSON.stringify(whitelist.json.candidates));

console.log('\nunreadable ledger fails closed');
const writesSoFar = archiveCalls.length;
await put('plugin-data/dsh-session-lock/locks.json', '{ this is not json');
const broken = await call(registered, ROUTE, { days: 3 });
check('a corrupt ledger refuses the whole run', broken.status === 503, JSON.stringify(broken.json));
check('a corrupt ledger archives nothing', archiveCalls.length === writesSoFar, `${archiveCalls.length} vs ${writesSoFar}`);

await rm(home, { recursive: true, force: true });

console.log('');
if (failures.length > 0) {
    console.log(`FAILED (${failures.length}): ${failures.join('; ')}`);
    process.exitCode = 1;
} else {
    console.log('all checks passed');
}
