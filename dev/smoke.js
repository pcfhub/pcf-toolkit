/*
 * Drives the real built bundle outside a browser.
 *
 *     npm run build && npm run smoke
 *
 * What it does: installs the DOM and the platform globals, loads
 * `out/controls/LinkField/bundle.js` the way a form would, drives the control
 * through the states a form can put it in, and asserts what it did.
 *
 * Why it exists alongside `npm start` and `dev/harness.html`: both of those
 * *show* you the control, and the states that matter most are ones nobody
 * thinks to look at — a column the user cannot read, a business rule that
 * failed, a host with no column metadata, a cleared value that has to travel
 * back as `null` rather than `undefined`. Those are decisions, they are what
 * regresses, and here they are assertions with an exit code.
 *
 * Why no test framework: there is none in this repository, and adding one to
 * run a handful of assertions against a bundle would be a dependency, a config
 * file and a second build pipeline for something `node` already does. It also
 * runs the **built bundle** rather than the TypeScript sources, which is the
 * part worth checking — webpack, the externals and the manifest all sit between
 * the source and what a form actually loads. CI runs it after the msbuild pack,
 * so there it drives the production bundle.
 *
 * **What passing here does NOT mean.** Every value below is supplied by this
 * file. It cannot tell you that the control looks right, that the stylesheet
 * applies, that focus order works, that a real form hands down what these
 * fixtures hand down, or that a save persists anything. Keep the answers to
 * those in SPEC.md under "Not verified".
 *
 * **And a stub must never be more capable than the thing it stands in for.**
 * `dev/host.js` withholds `security`, `attributes` and `fluentDesignLanguage`
 * exactly where the platform withholds them. When you add to it, stub the
 * refusals first — the argument the call requires, the field it omits, the
 * empty collection it hands back. If you cannot say what the real call
 * withholds, the stub is a guess and the assertions resting on it prove
 * nothing.
 *
 * ---
 *
 * **The assertions below the divider are a worked example. Replace them.**
 * Everything above the divider is plumbing that works for any field control;
 * the examples exercise the scaffolded control and are meant to be thrown away
 * with it.
 */

const fs = require('fs');
const vm = require('vm');
const path = require('path');

// Resolved from this file rather than from the working directory, so the script
// behaves the same run directly or through npm.
const root = path.join(__dirname, '..');
const dom = require('./dom.js');
const host = require('./host.js');
const clock = require('./clock.js');

const BUNDLE = path.join(root, 'out', 'controls', 'LinkField', 'bundle.js');

if (!fs.existsSync(BUNDLE)) {
    console.error('\n  No bundle at out/controls/LinkField. Run npm run build first.\n');
    process.exit(1);
}

/* ----------------------------------------------------------- the platform */

dom.install(global);

/*
 * Time, replaced with something the test drives.
 *
 * `vm.runInThisContext` below evaluates the bundle in *this* realm, so the
 * `Date`, `setInterval` and `setTimeout` the control closes over are the ones
 * installed here. That is what makes a control with a clock testable without
 * an injectable clock parameter — which would be production code bent to suit
 * a harness, and the only reason that seam would exist.
 *
 * A control with no timers is unaffected by this: nothing schedules, nothing
 * fires, and `time.pending()` stays at zero. Keep it anyway — the teardown
 * assertion at the bottom of this file is written against it, and it is the
 * assertion worth keeping when the worked example goes.
 *
 * The start value is arbitrary and fixed. A suite that starts at "now" asserts
 * something slightly different every time it runs.
 */
const time = clock.install(Date.UTC(2026, 0, 1, 12, 0, 0), global);

const registration = host.captureRegistration(global);

const source = fs.readFileSync(BUNDLE, 'utf8');

/*
 * The platform libraries, supplied under the names the bundle actually asks
 * for — read out of the bundle rather than written down here.
 *
 * A `<platform-library>` entry becomes a webpack external, and the global it
 * compiles to carries a version in its name. **That version is not the one the
 * manifest declares.** `pcf-scripts` maps a declared version onto the platform
 * build it supports, so Fluent `9.46.2` arrives as `FluentUIReactv940` and
 * React `16.14.0` as `Reactv16`. Hardcoding either is a trap that springs on
 * the next version bump, with a `ReferenceError` naming a global that appears
 * nowhere in the repository.
 *
 * A standard control has no externals at all, in which case both lists are
 * empty and nothing below runs.
 */
const reactGlobals = [...new Set(source.match(/\bReactv[\w]*\b/g) || [])];
const fluentGlobals = [...new Set(source.match(/\bFluentUIReact[\w]*\b/g) || [])];

let React = null;

if (reactGlobals.length > 0) {
    React = require(path.join(root, 'node_modules', 'react'));
    reactGlobals.forEach((name) => {
        global[name] = React;
    });
}

/*
 * Fluent is stubbed rather than loaded, the way the grid rig stubs it: every
 * component resolves to its own name as an element type, so
 * `React.createElement(Input, …)` produces `{ type: 'Input', props }` and the
 * props the control passed survive for inspection. These assertions are about
 * the control's decisions, not about how Fluent renders them — and Fluent 9
 * ships no UMD build, so there is nothing to load in a browser either.
 */
const fluent = new Proxy({}, { get: (_target, name) => (typeof name === 'string' ? name : undefined) });

fluentGlobals.forEach((name) => {
    global[name] = fluent;
});

vm.runInThisContext(source, { filename: 'bundle.js' });

/* ---------------------------------------------------------------- harness */

const results = [];

function check(label, ok, detail) {
    results.push({ ok, label, detail });
}

// `getString` returns a marked key rather than a real string, so an assertion
// can tell "read from the .resx" apart from "hardcoded in the source" — which
// would otherwise look identical in the output.
const marked = (key) => `resx:${key}`;

/**
 * Mount a fresh control in a given state and hand back everything worth
 * asserting about it.
 *
 * A new instance per state on purpose: `init` runs once per control on a real
 * form, so a suite that reused one instance would be testing a sequence the
 * platform never produces. Where the *sequence* is the point — a value arriving
 * after an edit — drive `updateView` again through the returned handle.
 */
/**
 * Every control mounted and not yet destroyed.
 *
 * A suite that mounts and walks away is testing something other than what it
 * says: an abandoned control keeps its interval and its `document` listeners,
 * so the next section's counts include them and the next event dispatched at
 * `document` reaches all of them. That is the leak the teardown assertion
 * exists to catch, and asserting it from inside one proves nothing.
 */
const live = [];

function disposeAll() {
    while (live.length > 0) {
        live.pop().destroy();
    }
}

function mount(options) {
    const container = dom.createElement('div');
    const calls = [];
    // `getString` first, so a single assertion can override it — the marked key
    // proves a string came from the .resx, but it cannot prove a `{0}` was
    // substituted, because a marked key has no `{0}` in it to substitute.
    const context = host.createContext({ getString: marked, ...options, calls });
    const instance = new registration.ctor();

    let notifications = 0;

    /*
     * The third argument is the state a previous mount handed to
     * `mode.setControlState`, and it was hard-coded to `{}` here — which made
     * the *return* half of that API unreachable from a suite. Pass `state` in
     * `options` to mount a control the way the platform remounts one after a
     * form tab switch. `{}` remains the default, because that is a first mount.
     */
    instance.init(context, () => {
        notifications += 1;
    }, options.state || {}, container);

    // A standard control returns nothing and has written into `container`; a
    // virtual one returns the element it wants rendered and was handed no
    // container at all.
    const element = instance.updateView(context);

    const handle = {
        instance,
        container,
        element,
        props: () => (element && element.props) || {},
        outputs: () => instance.getOutputs(),
        notifications: () => notifications,
        /** `trackContainerResize` / `setFullScreen` calls the control made. */
        calls: () => calls,
        /** Re-render in a new state, as the platform does on every change. */
        update: (next) => instance.updateView(host.createContext({ getString: marked, ...options, ...next })),
        /** Unmount, as the platform does when the form closes or navigates. */
        destroy: () => {
            instance.destroy();

            const at = live.indexOf(handle);

            if (at !== -1) {
                live.splice(at, 1);
            }
        },
        find: (selector) => container.querySelector(selector),
    };

    live.push(handle);

    return handle;
}

check('bundle registered a control', typeof registration.ctor === 'function');

if (typeof registration.ctor !== 'function') {
    report();
}

/* ======================================================================== *
 *  LinkField — a URL column rendered as a link you can follow.
 *
 *  Three platform APIs meet in this control and every one of them fails
 *  quietly, which is what the assertions below are for: `openUrl` returns
 *  `void`, `setControlState` returns a boolean nobody reads, and `client`
 *  reports advice rather than capability.
 * ======================================================================== */

/*
 * Every declared input, seeded on every mount.
 *
 * `dev/host.js` builds its `parameters` bag from the literals it knows about
 * plus whatever is in `options.inputs` — so a property this control declares in
 * its manifest and the rig has never heard of arrives as **`undefined`**, and
 * `parameters.linkLabel.raw` throws here while working perfectly on a form. The
 * platform always supplies the property object for a declared property; only the
 * rig does not.
 *
 * The fix belongs here rather than in a `?.` inside the control: production code
 * defending against a state the platform cannot produce is code nothing will
 * ever justify removing.
 */
/**
 * Fire an event the way dev/dom.js expects one.
 *
 * The stub dispatches the object it is handed straight to the listeners, with
 * no synthesis of its own — so an event missing  throws inside
 * the control rather than in the suite, and the stack blames the control for a
 * gap in the fixture.
 */
function fire(element, type, extra) {
    element.dispatchEvent({ type: type, target: element, preventDefault: function () {}, ...extra });

    return element;
}

/**
 * The arguments a control passed to one host call, in order.
 *
 * `dev/host.js` records calls as formatted *strings* — `setControlState({"draft":"x"})`
 * — rather than as tuples, because the log is also what `npm run harness` prints
 * beside the control. So reading one back means parsing it, and doing that here
 * once is better than eight assertions that each match a substring and quietly
 * pass when the shape changes.
 */
function args(handle, name) {
    return handle.calls()
        .filter((call) => call.startsWith(name + '('))
        .map((call) => JSON.parse(call.slice(name.length + 1, -1)));
}

const INPUTS = { linkLabel: null };

const open = (options) => mount({ ...options, inputs: { ...INPUTS, ...(options && options.inputs) } });

/* ------------------------------------------------------ what it renders */

const plain = open({ value: 'https://contoso.example.com/accounts/1?ref=form' });

check(
    'shows the site name rather than the whole address',
    plain.find('.LinkField-link').textContent === 'contoso.example.com',
    plain.find('.LinkField-link').textContent,
);

check(
    'and the maker\'s label wins over the derived one',
    open({ value: 'https://contoso.example.com/', inputs: { linkLabel: 'Customer portal' } })
        .find('.LinkField-link').textContent === 'Customer portal',
);

check(
    'the editable field carries the address itself, not the friendly name',
    plain.find('input').value === 'https://contoso.example.com/accounts/1?ref=form',
);

check(
    'an empty column offers nothing to open',
    open({ value: null }).find('.LinkField-open').hidden === true,
);

/* ------------------------------------------- the security boundary */

/*
 * The assertion this control exists to keep.
 *
 * `navigation.openUrl` hands the string to the host, and a host that resolves
 * `javascript:` runs it in the app's own origin — so a text column any user with
 * write access can edit becomes a way to run script in every other user's
 * session. This is an allow-list for that reason: a blocklist is a list of the
 * attacks somebody already thought of.
 */
const HOSTILE = [
    'javascript:alert(document.cookie)',
    'JavaScript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'file:///c:/windows/win.ini',
    '/relative/path',
    'contoso.example.com',
    '   ',
];

for (const hostile of HOSTILE) {
    const guarded = open({ value: hostile });

    fire(guarded.find('.LinkField-open'), 'click');

    check(
        `refuses to open ${JSON.stringify(hostile.slice(0, 32))}`,
        args(guarded, 'navigation.openUrl').length === 0,
        JSON.stringify(guarded.calls()),
    );

    check(
        `and never gives it an href — ${JSON.stringify(hostile.slice(0, 22))}`,
        guarded.find('.LinkField-link').getAttribute('href') === null,
        String(guarded.find('.LinkField-link').getAttribute('href')),
    );
}

for (const allowed of ['https://contoso.example.com/x', 'http://intranet/page']) {
    const followed = open({ value: allowed });

    fire(followed.find('.LinkField-open'), 'click');

    check(
        `opens ${allowed}`,
        args(followed, 'navigation.openUrl').includes(allowed),
        JSON.stringify(followed.calls()),
    );
}

/*
 * Through the platform, not through the DOM. An `<a href>` click that is not
 * prevented navigates the *form*, which inside a model-driven iframe reloads it
 * and loses the edit — and inside canvas escapes the app entirely.
 */
const viaAnchor = open({ value: 'https://contoso.example.com/x', disabled: true });

fire(viaAnchor.find('.LinkField-link'), 'click');

check(
    'a click on the link goes through navigation.openUrl, not the href',
    args(viaAnchor, 'navigation.openUrl').length > 0,
    JSON.stringify(viaAnchor.calls()),
);

/* ------------------------------------- the draft, across a remount */

/*
 * The form tab switch, in full. This is the round trip `mode.setControlState`
 * exists for and the reason the rig now passes `init`'s third argument: leaving
 * a tab destroys the control, and coming back inits a new one.
 */
const editing = open({ value: 'https://old.example.com/' });

editing.find('input').value = 'https://new.example.com/';
fire(editing.find('input'), 'input');

const saved = args(editing, 'setControlState').pop();

check(
    'an in-flight edit is handed to the platform',
    saved !== undefined && saved.draft === 'https://new.example.com/',
    JSON.stringify(saved),
);

check(
    'and reported as an output so the form knows it is dirty',
    editing.outputs().value === 'https://new.example.com/',
    JSON.stringify(editing.outputs()),
);

const remounted = open({ value: 'https://old.example.com/', state: { draft: 'https://new.example.com/' } });

check(
    'a remount restores the draft rather than the saved column',
    remounted.find('input').value === 'https://new.example.com/',
    remounted.find('input').value,
);

check(
    'and a remount with nothing saved shows the column',
    open({ value: 'https://old.example.com/' }).find('input').value === 'https://old.example.com/',
);

/*
 * An edit typed back to the saved value is not an edit. Persisting one would
 * resurrect it after the user had undone it, and mark a pristine form dirty.
 */
const undone = open({ value: 'https://old.example.com/' });

undone.find('input').value = 'https://old.example.com/';
fire(undone.find('input'), 'input');

check(
    'an edit typed back to the original is dropped, not persisted',
    args(undone, 'setControlState').pop().draft === '',
);

/*
 * The return value nobody reads. A host that takes the call and saves nothing
 * is invisible except here, so the control says so rather than implying the
 * edit is safe.
 */
const cannotSave = open({ value: 'https://old.example.com/', stateWritable: false });

cannotSave.find('input').value = 'https://new.example.com/';
fire(cannotSave.find('input'), 'input');
cannotSave.update({ stateWritable: false });

check(
    'a host that refuses to persist is admitted to, not hidden',
    cannotSave.find('.LinkField-message').textContent === 'resx:LinkField_NotPersisted',
    cannotSave.find('.LinkField-message').textContent,
);

/* ------------------------------------------------ what the client says */

check(
    'an unfollowable value is explained rather than silently inert',
    open({ value: 'not a url' }).find('.LinkField-message').textContent === 'resx:LinkField_Invalid',
);

check(
    'offline is a warning, not a lockout — the button stays live',
    open({ value: 'https://contoso.example.com/', offline: true }).find('.LinkField-open').disabled === false,
);

check(
    'and it says why',
    open({ value: 'https://contoso.example.com/', offline: true })
        .find('.LinkField-message').textContent === 'resx:LinkField_Offline',
);

/*
 * The platform's own validation outranks anything this control has to say. A
 * stack of messages under one input reads as a broken control.
 */
check(
    'a failed business rule outranks the control\'s own message',
    open({ value: 'not a url', error: true }).find('.LinkField-message').textContent
        === host.DEFAULTS.errorMessage,
);

check(
    'a phone gets the compact surface',
    open({ value: 'https://contoso.example.com/', formFactor: 'phone' })
        .container.classList.contains('LinkField--compact'),
);

check(
    'and a host that reports an unknown form factor does not',
    !open({ value: 'https://contoso.example.com/' }).container.classList.contains('LinkField--compact'),
);

/* --------------------------------------------------- the form's states */

const denied = open({ security: 'no-access', value: null });

check('a column the user cannot read hides the field', denied.find('.LinkField-field').hidden === true);
check(
    'and says which it is, rather than looking empty',
    denied.find('.LinkField-message').textContent === 'resx:LinkField_NoAccess',
);

check(
    'a read-only column shows the link and not the input',
    open({ value: 'https://contoso.example.com/', security: 'read-only' }).find('input').hidden === true,
);

check(
    'takes no position on the theme when the host publishes none',
    !open({ value: 'https://contoso.example.com/', host: 'canvas' })
        .container.classList.contains('LinkField--dark'),
);

/* ------------------------------------------------------------ teardown */

const torn = open({ value: 'https://contoso.example.com/' });
const wired = [torn.find('input'), torn.find('.LinkField-open'), torn.find('.LinkField-link')];
const count = () => wired.reduce((total, el) => total + Object.values(el.listeners).reduce((n, l) => n + l.length, 0), 0);
const before = count();

torn.destroy();

check(
    'destroy() releases every listener the control took',
    before > 0 && count() === 0,
    `${before} listener(s) before, ${count()} after`,
);

disposeAll();

report();

function report() {
    const failed = results.filter((result) => !result.ok);

    for (const result of results) {
        const detail = result.detail ? `  — ${result.detail}` : '';

        console.log(`  ${result.ok ? 'ok  ' : 'FAIL'}  ${result.label}${detail}`);
    }

    console.log(
        failed.length > 0
            ? `\n  ${failed.length} of ${results.length} failed\n`
            : `\n  ${results.length} passed — the control's own decisions only; see SPEC.md for what a real form still has to confirm\n`,
    );

    process.exit(failed.length > 0 ? 1 : 0);
}
