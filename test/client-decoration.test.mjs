/**
 * Offline harness for the browser half's sidebar decoration.
 *
 * The bug this guards against: `paintButton` used to rewrite `innerHTML` on
 * every sweep. Because the sweep is driven by a `MutationObserver` on the whole
 * document, that write re-armed the observer, which re-armed the write — the
 * lock <svg> was destroyed and rebuilt ~60 times a second, forever. A click
 * whose mousedown landed on that svg therefore never produced a `click` event
 * (the browser drops the click when the mousedown target has been detached from
 * the tree in between), so only the ring of button pixels around the icon was
 * clickable. Two write-ups came out of it — the class in the stylesheet was
 * never applied to the button either — hence the assertions below.
 *
 * The module is loaded as it ships in the browser (a `__ModuleLoader__.load`
 * call) and driven against a ~120-line DOM stub, so this test needs no jsdom
 * and no browser. Nothing here touches DSH state: `fetch` is stubbed out.
 *
 *   node test/client-decoration.test.mjs
 */

//#region DOM stub
/** Attribute selector subset used by the plugin: [a], [a="v"], [a*="v"]. */
function matchesSelector(element, selector) {
    const parsed = /^([a-z]+)?((?:\[[^\]]*\])*)$/i.exec(selector.trim());
    if (parsed === null) throw new Error(`unsupported selector: ${selector}`);
    const tag = parsed[1];
    if (tag !== undefined && element.tagName !== tag.toUpperCase()) return false;
    for (const part of parsed[2].match(/\[[^\]]*\]/g) ?? []) {
        const body = part.slice(1, -1);
        const star = body.includes('*=');
        const equals = !star && body.includes('=');
        const [rawName, rawValue] = body.split(star ? '*=' : '=');
        const name = rawName.trim();
        const value = rawValue === undefined ? null : rawValue.trim().replace(/^["']|["']$/g, '');
        const own = element.getAttribute(name);
        if (value === null) {
            if (own === null) return false;
        } else if (star) {
            if (own === null || !own.includes(value)) return false;
        } else if (own !== value) {
            return false;
        }
    }
    return true;
}

class ClassList {
    constructor() { this.names = new Set(); }
    add(...names) { for (const name of names) this.names.add(name); }
    remove(...names) { for (const name of names) this.names.delete(name); }
    contains(name) { return this.names.has(name); }
    toggle(name, force) {
        const want = force === undefined ? !this.names.has(name) : Boolean(force);
        if (want) this.names.add(name);
        else this.names.delete(name);
        return want;
    }
    get value() { return [...this.names].join(' '); }
    set value(text) { this.names = new Set(String(text).split(/\s+/).filter(Boolean)); }
}

class Element {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.classList = new ClassList();
        this.attributes = new Map();
        this.children = [];
        this.parentNode = null;
        this.listeners = new Map();
        this.style = {};
        this.title = '';
        this.textContent = '';
        this.innerHTMLWrites = 0;
        this.removed = false;
        this._innerHTML = '';
    }
    get className() { return this.classList.value; }
    set className(value) { this.classList.value = value; }
    get firstChild() { return this.children[0] ?? null; }
    get firstElementChild() { return this.children[0] ?? null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    set innerHTML(markup) {
        this._innerHTML = String(markup);
        this.innerHTMLWrites += 1;
        // The icon markup is a single <svg> subtree; keep one node for it so a
        // test can tell "repainted" from "left alone" by node identity.
        this.children = /<svg/i.test(this._innerHTML) ? [new Element('svg')] : [];
        for (const child of this.children) child.parentNode = this;
    }
    get innerHTML() { return this._innerHTML; }
    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }
    insertBefore(child, reference) {
        const index = reference === null || reference === undefined ? -1 : this.children.indexOf(reference);
        child.parentNode = this;
        if (index < 0) this.children.push(child);
        else this.children.splice(index, 0, child);
        return child;
    }
    remove() {
        this.removed = true;
        if (this.parentNode !== null) {
            const index = this.parentNode.children.indexOf(this);
            if (index >= 0) this.parentNode.children.splice(index, 1);
            this.parentNode = null;
        }
    }
    addEventListener(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(handler);
    }
    querySelector(selector) {
        for (const child of this.children) {
            if (matchesSelector(child, selector)) return child;
            const nested = child.querySelector(selector);
            if (nested !== null) return nested;
        }
        return null;
    }
}

const documentStub = {
    head: new Element('head'),
    body: new Element('body'),
    createElement: (tagName) => new Element(tagName),
    getElementById(id) {
        const search = (node) => {
            if (node.id === id || node.getAttribute('id') === id) return node;
            for (const child of node.children) {
                const hit = search(child);
                if (hit !== null) return hit;
            }
            return null;
        };
        return search(documentStub.head) ?? search(documentStub.body);
    },
    querySelectorAll(selector) {
        const found = [];
        const walk = (node) => {
            for (const child of node.children) {
                if (matchesSelector(child, selector)) found.push(child);
                walk(child);
            }
        };
        walk(documentStub.body);
        return found;
    },
    addEventListener() {},
};
//#endregion

//#region load the shipped browser half
let factory = null;
globalThis.window = {
    __ModuleLoader__: { load: (definition) => { factory = definition.factory; } },
    requestAnimationFrame: () => 0,
};
globalThis.document = documentStub;
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, locked: [] }) });

await import('../lib/client.js');
if (factory === null) throw new Error('client.js did not register itself with __ModuleLoader__');
const api = factory(() => { throw new Error('the browser half must not require any shell module'); });
//#endregion

const failures = [];
const check = (label, condition, detail = '') => {
    if (condition) {
        console.log(`  ok   ${label}`);
    } else {
        failures.push(label);
        console.log(`  FAIL ${label} ${detail}`);
    }
};

// apply() installs the stylesheet; it also installs a 3s interceptor timer that
// this test does not need to run (nothing here talks to the archive path).
const styleCleanups = [];
api.apply({
    effect(callback) { styleCleanups.push(callback()); return () => {}; },
    get: () => null,
    logger: { warn() {} },
});
const style = documentStub.getElementById('dsh-session-lock-css');
check('apply() installs the plugin stylesheet', style !== null);
const css = style?.textContent ?? '';

/** Build a sidebar row the way the real one reaches decorateRow. */
function makeRow(sessionId) {
    const row = new Element('div');
    row.className = 'YDXeBa_sessionRow';
    const slot = new Element('span');
    slot.className = 'YDXeBa_rowActions';
    row.appendChild(slot);
    row['__reactFiber$test'] = { memoizedProps: { node: { id: sessionId } }, return: null };
    return row;
}

console.log('\nrow decoration');
const sessionId = 'session-00000000-0000-0000-0000-000000000000';
const row = makeRow(sessionId);
api.__test.decorateRow(row);

const button = row.querySelector('button[data-dsh-session-lock]');
check('a lock button is inserted', button !== null);
check('the button carries the stylesheet class',
    button.classList.contains('dsh-session-lock-btn'),
    `class="${button.className}"`);
check('the stylesheet actually styles that class', css.includes('.dsh-session-lock-btn{'));
check('the button id is the resolved session id',
    button.getAttribute('data-dsh-session-lock') === sessionId);
check('the button listens for click', (button.listeners.get('click') ?? []).length === 1);
check('the button swallows pointerdown so the row does not react',
    (button.listeners.get('pointerdown') ?? []).length === 1);

console.log('\nrepaint stability (the click-eating bug)');
const iconBefore = button.firstElementChild;
const writesBefore = button.innerHTMLWrites;
check('the first paint drew an icon', iconBefore !== null, `tag=${iconBefore?.tagName ?? '(none)'}`);

for (let pass = 0; pass < 25; pass += 1) api.__test.decorateRow(row);
check('25 repaints write no innerHTML', button.innerHTMLWrites === writesBefore,
    `${button.innerHTMLWrites - writesBefore} write(s)`);
check('25 repaints keep the same icon node', button.firstElementChild === iconBefore);
check('the icon is markup for an <svg>', String(button.innerHTML).includes('<svg'));

console.log('\nrepaint on a real state change');
api.__test.lockedIds.add(sessionId);
api.__test.decorateRow(row);
check('locking repaints the icon exactly once', button.innerHTMLWrites === writesBefore + 1,
    `${button.innerHTMLWrites - writesBefore} write(s)`);
check('locking flips the class', button.classList.contains('is-locked'));
check('locking swaps the icon node', button.firstElementChild !== iconBefore);
check('the row is marked locked', row.classList.contains('dsh-session-lock-row'));
const iconLocked = button.firstElementChild;

for (let pass = 0; pass < 25; pass += 1) api.__test.decorateRow(row);
check('the locked icon is stable across repaints', button.firstElementChild === iconLocked);
api.__test.lockedIds.delete(sessionId);
api.__test.decorateRow(row);
check('unlocking repaints the icon exactly once', button.innerHTMLWrites === writesBefore + 2,
    `${button.innerHTMLWrites - writesBefore} write(s)`);
check('unlocking clears the class and the row marker',
    !button.classList.contains('is-locked') && !row.classList.contains('dsh-session-lock-row'));

console.log('\nclick target');
check('the stylesheet makes the icon click-through',
    /\.dsh-session-lock-btn>svg\{[^}]*pointer-events:none/.test(css),
    'without pointer-events:none the <svg> steals the hit target from the button');
check('the button box is a fixed size, so the icon cannot resize it',
    /\.dsh-session-lock-btn\{[^}]*width:20px;height:20px/.test(css));

console.log('');
if (failures.length > 0) {
    console.log(`FAILED (${failures.length}): ${failures.join('; ')}`);
    process.exit(1);
}
console.log('all checks passed');
process.exit(0);
