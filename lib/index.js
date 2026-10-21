/**
 * dsh-session-lock — host half.
 *
 * Owns the durable lock ledger and the HTTP surface the browser half drives.
 * There is no official "protect this session" flag in the workspace registry,
 * so the ledger lives here and the browser half enforces it by wrapping the
 * client `workspaces.archiveSession` method (see lib/client.js).
 *
 * Routes (all same-origin, all carrying the `x-dsh-session-lock: 1` marker):
 *
 *   GET  /plugins/dsh-session-lock/locks       → { ok, locked: string[], records }
 *   POST /plugins/dsh-session-lock/set         → { sessionId, locked, note? }
 *   POST /plugins/dsh-session-lock/unlock-all  → drop every lock
 *   GET  /plugins/dsh-session-lock/health      → { ok, count }
 *   POST /plugins/dsh-session-lock/archive-inactive → { days?, dryRun?, sessionIds? }
 *        archives every stored session whose log has not been written for
 *        `days` days, skipping locked, live, and already-archived sessions.
 *        This is the only archive path that bypasses the browser half, so the
 *        lock exemption is enforced here against the on-disk ledger directly
 *        (fail-closed: an unreadable ledger refuses the whole run).
 *
 * Storage: $DSH_HOME/plugin-data/dsh-session-lock/locks.json, written whole-
 * file and atomically (temp + rename). The file is the only writer's copy of
 * the truth, so the in-process cache is authoritative after the first read;
 * a corrupt or unreadable file degrades to "nothing is locked" rather than
 * failing the boot.
 *
 * The trust fence deliberately does NOT require a loopback socket or a
 * loopback Host header: this deployment is normally reached through nginx on
 * the LAN, where the Host header is the public name and the socket peer is
 * the local proxy. What is required instead is a non-simple custom header
 * (which a cross-site form post cannot set) plus a refusal of explicit
 * `sec-fetch-site: cross-site` requests.
 *
 * @module dsh-session-lock
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';

/** Stable cordis plugin name. */
export const name = 'session-lock';

/** Services required before the routes can mount. */
export const inject = ['webServer'];

const ROUTE_PREFIX = '/plugins/dsh-session-lock';
/** Non-simple request marker: proves the caller is our own fetch, not a form post. */
const GUARD_HEADER = 'x-dsh-session-lock';
const MAX_BODY_BYTES = 64 * 1024;
/** Session ids are opaque; keep them printable and bounded. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const MAX_NOTE_LENGTH = 200;
/** Default staleness horizon for `archive-inactive`, in days. */
const DEFAULT_INACTIVE_DAYS = 3;
/** Hard ceiling on staleness so a typo cannot archive everything. */
const MAX_INACTIVE_DAYS = 3650;
/** Upper bound on sessions archived by one call, so a run cannot stampede. */
const MAX_ARCHIVE_PER_RUN = 500;
/** Session log artifacts inside one session directory (the header + events). */
const LOG_FILE_PATTERN = /^session\..*\.jsonl(\.zstd)?$/;

/** JSON response with the family defaults. */
function send(res, status, value) {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(JSON.stringify(value));
}

/** Bounded JSON request body. */
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let bytes = 0;
        let settled = false;
        req.on('data', (chunk) => {
            if (settled) return;
            bytes += chunk.length;
            if (bytes > MAX_BODY_BYTES) {
                settled = true;
                reject(Object.assign(new Error('request body is too large'), { status: 413 }));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (settled) return;
            settled = true;
            const text = Buffer.concat(chunks).toString('utf8').trim();
            if (text === '') {
                resolve({});
                return;
            }
            try {
                const parsed = JSON.parse(text);
                if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    reject(Object.assign(new Error('request body must be a JSON object'), { status: 400 }));
                    return;
                }
                resolve(parsed);
            } catch {
                reject(Object.assign(new Error('request body is not valid JSON'), { status: 400 }));
            }
        });
        req.on('error', (error) => {
            if (settled) return;
            settled = true;
            reject(error);
        });
    });
}

/** Method + same-origin trust fence shared by every route. */
function guard(req, res, method) {
    if (req.headers['sec-fetch-site'] === 'cross-site') {
        send(res, 403, { ok: false, error: 'forbidden' });
        return false;
    }
    if (req.headers[GUARD_HEADER] !== '1') {
        send(res, 403, { ok: false, error: 'forbidden' });
        return false;
    }
    if (req.method !== method) {
        send(res, 405, { ok: false, error: 'method-not-allowed' });
        return false;
    }
    return true;
}

/** One ledger shape check; anything unexpected degrades to an empty ledger. */
function normalizeState(raw) {
    const locked = {};
    const source = raw !== null && typeof raw === 'object' ? raw.locked : undefined;
    if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
        for (const [sessionId, record] of Object.entries(source)) {
            if (!SESSION_ID_PATTERN.test(sessionId)) continue;
            const at = record !== null && typeof record === 'object' && typeof record.at === 'string'
                ? record.at
                : null;
            const note = record !== null && typeof record === 'object' && typeof record.note === 'string'
                ? record.note.slice(0, MAX_NOTE_LENGTH)
                : null;
            locked[sessionId] = { at, note };
        }
    }
    return { version: 1, locked };
}

/**
 * One stored session as the archiver sees it.
 * @typedef {object} StoredSession
 * @property {string} id - session id (the session directory name).
 * @property {number} mtimeMs - newest write time of the session's log artifacts.
 * @property {string} project - the on-disk project directory name (lossy cwd).
 */

/**
 * Walk `$DSH_HOME/sessions/<project>/<sessionId>/` and report each session's
 * last log write. This reads the same artifacts session persistence owns, so
 * it needs no service injection: a missing root degrades to "no sessions",
 * which the caller reports as a scanned count rather than an error.
 * @param {string} sessionsRoot - the sessions root directory.
 * @returns {Promise<Map<string, StoredSession>>} id → newest log write.
 */
async function scanSessionLogs(sessionsRoot) {
    const found = new Map();
    let projects;
    try {
        projects = await readdir(sessionsRoot, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT') return found;
        throw error;
    }
    for (const project of projects) {
        if (!project.isDirectory()) continue;
        const projectPath = join(sessionsRoot, project.name);
        let sessionDirs;
        try {
            sessionDirs = await readdir(projectPath, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const dir of sessionDirs) {
            if (!dir.isDirectory() || !SESSION_ID_PATTERN.test(dir.name)) continue;
            const dirPath = join(projectPath, dir.name);
            let files;
            try {
                files = await readdir(dirPath);
            } catch {
                continue;
            }
            let mtimeMs = null;
            for (const file of files) {
                if (!LOG_FILE_PATTERN.test(file)) continue;
                try {
                    const info = await stat(join(dirPath, file));
                    if (mtimeMs === null || info.mtimeMs > mtimeMs) mtimeMs = info.mtimeMs;
                } catch {
                    /* a log that vanished between readdir and stat is not a session */
                }
            }
            if (mtimeMs === null) continue;
            const previous = found.get(dir.name);
            if (previous === undefined || mtimeMs > previous.mtimeMs) {
                found.set(dir.name, { id: dir.name, mtimeMs, project: project.name });
            }
        }
    }
    return found;
}

/**
 * Best-effort session title from the projection cache. A missing or unreadable
 * cache entry yields `null`; titles are decoration, never a decision input.
 * @param {string} dshHome - the DSH home directory.
 * @param {string} sessionId - session whose title to read.
 * @returns {Promise<string|null>} the title, or `null`.
 */
async function readSessionTitle(dshHome, sessionId) {
    try {
        const raw = await readFile(join(dshHome, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`), 'utf8');
        const title = JSON.parse(raw)?.record?.rows?.title?.val;
        return typeof title === 'string' && title !== '' ? title : null;
    } catch {
        return null;
    }
}

/** Public projection for one session in an archiver response. */
function describeSession(entry, titles, workspaces) {
    const workspace = workspaces.get(entry.id) ?? null;
    return {
        id: entry.id,
        title: titles.get(entry.id) ?? null,
        workspaceId: workspace?.id ?? null,
        workspacePath: workspace?.path ?? null,
        project: entry.project,
        lastModified: new Date(entry.mtimeMs).toISOString(),
    };
}

/**
 * Mount the lock ledger and its routes.
 * @param ctx - host plugin context carrying `webServer` and `logger`.
 */
export function apply(ctx) {
    const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    const dataDir = join(dshHome, 'plugin-data', 'dsh-session-lock');
    const statePath = join(dataDir, 'locks.json');

    /** In-memory ledger; `null` until the first successful read. */
    let state = null;
    /** Serializes whole-file writes so concurrent toggles cannot interleave. */
    let writeChain = Promise.resolve();

    async function load() {
        if (state !== null) return state;
        try {
            state = normalizeState(JSON.parse(await readFile(statePath, 'utf8')));
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                ctx.logger?.warn?.(`session-lock: unreadable ledger (${String(error?.code ?? error)}); starting empty`);
            }
            state = normalizeState(null);
        }
        return state;
    }

    function persist() {
        const payload = `${JSON.stringify(state, null, 2)}\n`;
        writeChain = writeChain
            .then(async () => {
                await mkdir(dataDir, { recursive: true });
                const temp = `${statePath}.${process.pid}.${Date.now()}.tmp`;
                await writeFile(temp, payload, 'utf8');
                await rename(temp, statePath);
            })
            .catch((error) => {
                ctx.logger?.warn?.(`session-lock: ledger write failed: ${String(error)}`);
            });
        return writeChain;
    }

    /** Locked ids, newest first so the browser list is stable across reloads. */
    function lockedIds(current) {
        return Object.entries(current.locked)
            .sort((left, right) => String(right[1]?.at ?? '').localeCompare(String(left[1]?.at ?? '')))
            .map(([sessionId]) => sessionId);
    }

    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/locks`,
        handler: async (req, res) => {
            if (!guard(req, res, 'GET')) return;
            try {
                const current = await load();
                send(res, 200, { ok: true, locked: lockedIds(current), records: current.locked });
            } catch (error) {
                send(res, 500, { ok: false, error: 'ledger-unavailable', message: String(error?.message ?? error) });
            }
        },
    }), 'session-lock: locks route');

    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/set`,
        handler: async (req, res) => {
            if (!guard(req, res, 'POST')) return;
            try {
                const body = await readJsonBody(req);
                const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
                if (!SESSION_ID_PATTERN.test(sessionId)) {
                    send(res, 400, { ok: false, error: 'invalid-session-id' });
                    return;
                }
                if (typeof body.locked !== 'boolean') {
                    send(res, 400, { ok: false, error: 'invalid-locked' });
                    return;
                }
                const current = await load();
                if (body.locked) {
                    const note = typeof body.note === 'string' && body.note !== ''
                        ? body.note.slice(0, MAX_NOTE_LENGTH)
                        : null;
                    current.locked[sessionId] = { at: new Date().toISOString(), note };
                } else {
                    delete current.locked[sessionId];
                }
                await persist();
                send(res, 200, { ok: true, locked: lockedIds(current), records: current.locked });
            } catch (error) {
                const status = Number.isInteger(error?.status) ? error.status : 500;
                send(res, status, { ok: false, error: 'lock-failed', message: String(error?.message ?? error) });
            }
        },
    }), 'session-lock: set route');

    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/unlock-all`,
        handler: async (req, res) => {
            if (!guard(req, res, 'POST')) return;
            try {
                const current = await load();
                current.locked = {};
                await persist();
                send(res, 200, { ok: true, locked: [], records: {} });
            } catch (error) {
                send(res, 500, { ok: false, error: 'lock-failed', message: String(error?.message ?? error) });
            }
        },
    }), 'session-lock: unlock-all route');

    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/health`,
        handler: async (req, res) => {
            if (!guard(req, res, 'GET')) return;
            const current = await load();
            send(res, 200, { ok: true, count: Object.keys(current.locked).length, path: statePath });
        },
    }), 'session-lock: health route');

    /**
     * Read the lock ledger straight from disk for a destructive decision.
     * Unlike {@link load} this never caches and never degrades an unreadable
     * ledger to "nothing is locked": archiving must fail closed, because a
     * missed lock would archive a session the user explicitly protected.
     * @returns {Promise<Set<string>>} locked session ids.
     */
    async function readLockedIdsStrict() {
        try {
            const parsed = JSON.parse(await readFile(statePath, 'utf8'));
            return new Set(Object.keys(normalizeState(parsed).locked));
        } catch (error) {
            if (error?.code === 'ENOENT') return new Set();
            throw error;
        }
    }

    ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/archive-inactive`,
        handler: async (req, res) => {
            if (!guard(req, res, 'POST')) return;
            try {
                const body = await readJsonBody(req);
                const days = body.days === undefined ? DEFAULT_INACTIVE_DAYS : body.days;
                if (typeof days !== 'number' || !Number.isFinite(days) || days < 0 || days > MAX_INACTIVE_DAYS) {
                    send(res, 400, { ok: false, error: 'invalid-days', maxDays: MAX_INACTIVE_DAYS });
                    return;
                }
                const dryRun = body.dryRun === true;
                const only = Array.isArray(body.sessionIds)
                    ? new Set(body.sessionIds.filter((id) => typeof id === 'string' && SESSION_ID_PATTERN.test(id)))
                    : null;
                // Mirror dsh-archived-chats: older builds exposed this service
                // under the shorter name 'workspace'.
                const registry = ctx.get('workspaceRegistry') ?? ctx.get('workspace');
                if (registry === undefined || typeof registry.archiveSession !== 'function') {
                    send(res, 503, { ok: false, error: 'workspace-registry-unavailable' });
                    return;
                }

                let locked;
                try {
                    locked = await readLockedIdsStrict();
                } catch (error) {
                    ctx.logger?.warn?.(`session-lock: archive refused, unreadable ledger: ${String(error)}`);
                    send(res, 503, { ok: false, error: 'lock-ledger-unavailable', message: String(error?.message ?? error) });
                    return;
                }

                const archivedIds = new Set(Array.from(registry.archivedSessionIds ?? [], String));
                const sessions = ctx.get('sessions');
                const workspaces = new Map();
                for (const workspace of registry.list()) {
                    for (const sessionId of workspace.sessionIds) {
                        workspaces.set(String(sessionId), { id: String(workspace.id), path: workspace.path, title: workspace.title });
                    }
                }

                const stored = await scanSessionLogs(join(dshHome, 'sessions'));
                const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
                const candidates = [];
                const skipped = { locked: [], live: [], alreadyArchived: [], recent: 0 };

                for (const entry of stored.values()) {
                    if (only !== null && !only.has(entry.id)) continue;
                    if (locked.has(entry.id)) {
                        skipped.locked.push(entry.id);
                        continue;
                    }
                    if (archivedIds.has(entry.id)) {
                        skipped.alreadyArchived.push(entry.id);
                        continue;
                    }
                    if (entry.mtimeMs > cutoffMs) {
                        skipped.recent += 1;
                        continue;
                    }
                    let live = false;
                    try {
                        live = sessions?.get?.(entry.id) !== undefined;
                    } catch {
                        /* an unreachable live-session index must not block archiving */
                    }
                    if (live) {
                        skipped.live.push(entry.id);
                        continue;
                    }
                    candidates.push(entry);
                }
                candidates.sort((left, right) => left.mtimeMs - right.mtimeMs);

                const titles = new Map();
                for (const entry of candidates) titles.set(entry.id, await readSessionTitle(dshHome, entry.id));

                const selected = candidates.slice(0, MAX_ARCHIVE_PER_RUN);
                const archived = [];
                const failed = [];
                if (!dryRun) {
                    for (const entry of selected) {
                        try {
                            await registry.archiveSession(entry.id);
                            archived.push(describeSession(entry, titles, workspaces));
                        } catch (error) {
                            failed.push({ id: entry.id, error: String(error?.message ?? error) });
                        }
                    }
                }

                send(res, 200, {
                    ok: true,
                    dryRun,
                    days,
                    cutoff: new Date(cutoffMs).toISOString(),
                    scanned: stored.size,
                    candidates: candidates.map((entry) => describeSession(entry, titles, workspaces)),
                    archived,
                    failed,
                    truncated: candidates.length > MAX_ARCHIVE_PER_RUN,
                    skipped: {
                        locked: skipped.locked,
                        live: skipped.live,
                        alreadyArchived: skipped.alreadyArchived,
                        recent: skipped.recent,
                    },
                });
            } catch (error) {
                const status = Number.isInteger(error?.status) ? error.status : 500;
                send(res, status, { ok: false, error: 'archive-inactive-failed', message: String(error?.message ?? error) });
            }
        },
    }), 'session-lock: archive-inactive route');
}
