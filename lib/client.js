/**
 * dsh-session-lock — browser half.
 *
 * Loaded by dsh-client-modules at /plugins/dsh-session-lock/client.js and
 * executed through the vendored cordis Loader's lazy-CJS module table
 * (window.__ModuleLoader__.load). The factory body is plain CJS with require()
 * resolved against the shell's module table — the same shape the shipped ui-*
 * packages emit. This half deliberately requires no shell module: it is plain
 * DOM plus one fetch client, so a runtime that renames an internal package
 * cannot break it.
 *
 * What it does:
 *   1. Wraps the client `workspaces.archiveSession` method. A locked session
 *      is never handed to the real archive path; the user gets a toast that
 *      names the reason instead.
 *   2. Decorates every sidebar session row with a lock toggle (a plain
 *      MutationObserver pass; the React tree may re-render rows at any time).
 *   3. Reads the session id off the row's React fiber — the sidebar does not
 *      put session ids in the DOM, and the fiber props of the row component
 *      are the only stable handle on them.
 *
 * The ledger itself is host-owned (see lib/index.js). This half mirrors it and
 * re-reads the mirror after every toggle. Until that first read lands the
 * mirror is empty, which fails OPEN: an unlocked-looking session archives
 * normally. Blocking on a ledger we could not read would be worse than letting
 * a session through.
 */
window.__ModuleLoader__.load({
    id: "dsh-session-lock",
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

        //#region constants
        const API = "/plugins/dsh-session-lock";
        const GUARD_HEADER = "x-dsh-session-lock";
        const STYLE_ID = "dsh-session-lock-css";
        const BUTTON_ATTR = "data-dsh-session-lock";
        const BUTTON_CLASS = "dsh-session-lock-btn";
        const ICON_ATTR = "data-dsh-session-lock-icon";
        const TOAST_ID = "dsh-session-lock-toast";
        const ICON_LOCKED = "locked";
        const ICON_UNLOCKED = "unlocked";
        const CSS = [
            ".dsh-session-lock-btn{display:inline-flex;align-items:center;justify-content:center;",
            "width:20px;height:20px;padding:0;border:0;border-radius:6px;background:transparent;",
            "color:inherit;cursor:pointer;opacity:.5;transition:opacity .12s ease,color .12s ease;",
            "user-select:none;-webkit-user-select:none;}",
            ".dsh-session-lock-btn>svg{display:block;pointer-events:none;}",
            ".dsh-session-lock-btn:hover{opacity:1;background:color-mix(in srgb,currentColor 14%,transparent);}",
            ".dsh-session-lock-btn.is-locked{opacity:1;color:#e8a33d;}",
            ".dsh-session-lock-btn.is-locked>svg{pointer-events:none;}",
            ".dsh-session-lock-btn:focus-visible{outline:2px solid #e8a33d;outline-offset:1px;}",
            ".dsh-session-lock-btn[disabled]{cursor:progress;opacity:.4;}",
            ".dsh-session-lock-row{box-shadow:inset 2px 0 0 0 rgba(232,163,61,.75);}",
            ".dsh-session-lock-toast{position:fixed;left:50%;bottom:88px;transform:translateX(-50%);",
            "z-index:2147483000;max-width:min(520px,86vw);padding:9px 14px;border-radius:10px;",
            "background:rgba(28,28,30,.94);color:#f5f5f7;font-size:13px;line-height:1.45;",
            "box-shadow:0 8px 28px rgba(0,0,0,.38);pointer-events:none;opacity:0;",
            "transition:opacity .16s ease;}",
            ".dsh-session-lock-toast.is-visible{opacity:1;}",
        ].join("");
        const LOCKED_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>';
        const UNLOCKED_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>';
        const TEXT_ARCHIVE_BLOCKED = "该会话已锁定，未被归档。先点会话行里的锁图标解锁。";
        const TEXT_LOCKED = "已锁定：该会话不会被归档";
        const TEXT_UNLOCKED = "已解锁：该会话可以归档";
        const TEXT_TOGGLE_FAILED = "会话锁写入失败，请重试。";
        const TEXT_LOAD_FAILED = "会话锁列表读取失败，本次浏览器的锁状态未生效。";
        //#endregion

        //#region ledger mirror
        /** Session ids the host currently reports as locked. */
        const lockedIds = new Set();

        async function request(path, init) {
            const res = await fetch(`${API}${path}`, {
                ...init,
                cache: "no-store",
                headers: { [GUARD_HEADER]: "1", ...(init?.headers ?? {}) },
            });
            let body = null;
            try { body = await res.json(); } catch { body = null; }
            if (!res.ok || body?.ok === false) {
                throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`);
            }
            return body;
        }

        function replaceLedger(body) {
            lockedIds.clear();
            for (const id of Array.isArray(body?.locked) ? body.locked : []) lockedIds.add(String(id));
        }

        async function readLedger() {
            replaceLedger(await request("/locks"));
        }

        async function writeLock(sessionId, locked) {
            replaceLedger(await request("/set", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ sessionId, locked }),
            }));
        }
        //#endregion

        //#region toast
        let toastNode = null;
        let toastTimer = 0;

        function showToast(message) {
            try {
                if (typeof document === "undefined" || document.body === null) return;
                if (toastNode === null || !toastNode.isConnected) {
                    toastNode = document.createElement("div");
                    toastNode.id = TOAST_ID;
                    toastNode.className = "dsh-session-lock-toast";
                    toastNode.setAttribute("role", "status");
                    toastNode.setAttribute("aria-live", "polite");
                    document.body.appendChild(toastNode);
                }
                toastNode.textContent = message;
                toastNode.classList.add("is-visible");
                if (toastTimer !== 0) clearTimeout(toastTimer);
                toastTimer = setTimeout(() => {
                    toastTimer = 0;
                    toastNode?.classList?.remove("is-visible");
                }, 3600);
            } catch { /* a toast is best-effort */ }
        }

        function disposeToast() {
            if (toastTimer !== 0) { clearTimeout(toastTimer); toastTimer = 0; }
            try { toastNode?.remove?.(); } catch { /* already detached */ }
            toastNode = null;
        }
        //#endregion

        //#region session id resolution
        /**
         * Read the session id off a sidebar row.
         *
         * The sidebar renders no session id into the DOM, so the only handle is
         * the React fiber attached to the row: walk up until a component whose
         * props carry a node/session object with a string id. Returns null when
         * the fiber is missing (a non-React host, or a future sidebar rewrite),
         * in which case the row is left alone rather than decorated wrongly.
         */
        function sessionIdOf(row) {
            try {
                const key = Object.keys(row).find((candidate) => candidate.startsWith("__reactFiber"));
                let fiber = key === undefined ? null : row[key];
                for (let depth = 0; fiber !== null && fiber !== undefined && depth < 16; depth += 1) {
                    const props = fiber.memoizedProps;
                    if (props !== null && typeof props === "object") {
                        const carrier = props.node ?? props.session ?? props.item ?? null;
                        const id = carrier !== null && typeof carrier === "object" ? carrier.id : null;
                        if (typeof id === "string" && id !== "") return id;
                    }
                    fiber = fiber.return;
                }
            } catch { /* fall through to null */ }
            return null;
        }
        //#endregion

        //#region row decoration
        /**
         * Repaint one lock button.
         *
         * Every DOM write here is idempotent, and the icon markup is rewritten
         * only when the icon actually changes. That is not an optimisation: the
         * sidebar sweep runs on every mutation of the document, so an
         * unconditional `innerHTML` write would replace the <svg> child on
         * every frame, and a click whose mousedown landed on that svg would
         * then never produce a `click` event (the browser drops the click when
         * the mousedown target was detached from the tree in between). The
         * icon must therefore survive a repaint, and it must not swallow the
         * click either — see the `pointer-events:none` rule in CSS.
         */
        function paintButton(button, locked) {
            button.classList.add(BUTTON_CLASS);
            button.classList.toggle("is-locked", locked);
            const icon = locked ? ICON_LOCKED : ICON_UNLOCKED;
            if (button.getAttribute(ICON_ATTR) !== icon) {
                button.setAttribute(ICON_ATTR, icon);
                button.innerHTML = locked ? LOCKED_ICON : UNLOCKED_ICON;
            }
            button.title = locked ? TEXT_LOCKED : TEXT_UNLOCKED;
            button.setAttribute("aria-label", locked ? TEXT_LOCKED : TEXT_UNLOCKED);
            button.setAttribute("aria-pressed", locked ? "true" : "false");
        }

        function decorateRow(row) {
            const sessionId = sessionIdOf(row);
            if (sessionId === null) return;
            // Rows carry their actions in a dedicated slot; a blank session has
            // none. Fall back to APPENDING to the row — prepending would shove
            // the button in front of the session title.
            const slot = row.querySelector('span[class*="rowActions"]');
            let button = row.querySelector(`button[${BUTTON_ATTR}]`);
            if (button === null) {
                button = document.createElement("button");
                button.type = "button";
                button.className = BUTTON_CLASS;
                button.setAttribute(BUTTON_ATTR, sessionId);
                button.addEventListener("pointerdown", (event) => event.stopPropagation());
                button.addEventListener("click", (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void toggle(button);
                });
                if (slot === null) row.appendChild(button);
                else slot.insertBefore(button, slot.firstChild);
            } else if (button.getAttribute(BUTTON_ATTR) !== sessionId) {
                button.setAttribute(BUTTON_ATTR, sessionId);
            }
            const locked = lockedIds.has(sessionId);
            row.classList.toggle("dsh-session-lock-row", locked);
            paintButton(button, locked);
        }

        async function toggle(button) {
            const sessionId = button.getAttribute(BUTTON_ATTR);
            if (sessionId === null || sessionId === "" || button.disabled) return;
            const next = !lockedIds.has(sessionId);
            button.disabled = true;
            try {
                await writeLock(sessionId, next);
                showToast(next ? TEXT_LOCKED : TEXT_UNLOCKED);
            } catch {
                showToast(TEXT_TOGGLE_FAILED);
            } finally {
                button.disabled = false;
                sweep();
            }
        }

        function sweep() {
            try {
                if (typeof document === "undefined") return;
                for (const row of document.querySelectorAll('div[class*="sessionRow"]')) decorateRow(row);
            } catch { /* one bad row must not stop the sweep */ }
        }
        //#endregion

        //#region archive interceptor
        /**
         * Wrap `workspaces.archiveSession`. The wrap is installed once and then
         * re-asserted by a slow timer, because sibling plugins (and this
         * plugin's own HMR reload) may replace the method. The disposer
         * restores the previous method when it is still ours, so a reload
         * cannot leave a stale closure holding the old ledger.
         */
        function installInterceptor(ctx) {
            const seen = new WeakSet();
            let installed = null;
            let previous = null;

            const assert = () => {
                let workspaces = null;
                try { workspaces = ctx.get("workspaces"); } catch { workspaces = null; }
                if (workspaces === null || typeof workspaces !== "object") return;
                if (typeof workspaces.archiveSession !== "function") return;
                if (installed === workspaces.archiveSession) return;
                if (seen.has(workspaces.archiveSession)) return;
                const original = workspaces.archiveSession;
                const guarded = function archiveSessionWithLock(sessionId) {
                    let locked = false;
                    try { locked = lockedIds.has(String(sessionId)); } catch { locked = false; }
                    if (locked) {
                        showToast(TEXT_ARCHIVE_BLOCKED);
                        return Promise.resolve();
                    }
                    return original.apply(this, arguments);
                };
                seen.add(guarded);
                try {
                    workspaces.archiveSession = guarded;
                    installed = guarded;
                    previous = original;
                    console.info("[dsh-session-lock] archive interceptor installed");
                } catch (error) {
                    console.warn("[dsh-session-lock] could not wrap archiveSession:", error);
                }
            };

            assert();
            const timer = setInterval(assert, 3000);
            return () => {
                clearInterval(timer);
                if (installed === null || previous === null) return;
                try {
                    let workspaces = null;
                    try { workspaces = ctx.get("workspaces"); } catch { workspaces = null; }
                    if (workspaces !== null && workspaces.archiveSession === installed) {
                        workspaces.archiveSession = previous;
                    }
                } catch { /* the service is already gone; nothing to restore */ }
                installed = null;
                previous = null;
            };
        }
        //#endregion

        //#region style + observer
        function ensureStyle() {
            if (typeof document === "undefined") return;
            if (document.getElementById(STYLE_ID) !== null) return;
            const style = document.createElement("style");
            style.id = STYLE_ID;
            style.textContent = CSS;
            document.head.appendChild(style);
        }

        function startObserver() {
            let observer = null;
            let scheduled = false;
            const schedule = () => {
                if (scheduled) return;
                scheduled = true;
                const run = () => { scheduled = false; sweep(); };
                if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(run);
                else setTimeout(run, 32);
            };
            try {
                observer = new MutationObserver(schedule);
                observer.observe(document.body, { childList: true, subtree: true });
            } catch (error) {
                console.warn("[dsh-session-lock] sidebar observer unavailable:", error);
                observer = null;
            }
            return () => { try { observer?.disconnect?.(); } catch { /* already gone */ } };
        }
        //#endregion

        //#region plugin body
        function apply(ctx) {
            ensureStyle();
            ctx.effect(() => () => {
                try { document.getElementById(STYLE_ID)?.remove(); } catch { /* already gone */ }
                disposeToast();
            }, "session-lock: css + toast cleanup");

            ctx.effect(() => startObserver(), "session-lock: sidebar observer cleanup");
            ctx.effect(() => installInterceptor(ctx), "session-lock: archive interceptor");

            // The ledger read is async; rows painted before it lands are
            // repainted by the observer, and this sweep covers the case where
            // the sidebar finished rendering first.
            readLedger()
                .then(() => sweep())
                .catch((error) => {
                    console.warn("[dsh-session-lock] ledger read failed:", error);
                    showToast(TEXT_LOAD_FAILED);
                });
        }
        //#endregion

        exports.__test = { decorateRow, sessionIdOf, installInterceptor, lockedIds };
        exports.apply = apply;
        exports.inject = [];
        return module.exports;
    },
});
