/*
 * Drives the real built bundle outside a browser.
 *
 *     npm run build && npm run smoke
 *
 * What it does: installs the DOM and the platform globals, loads
 * `out/controls/LinkColumn/bundle.js` the way a form would, binds it to a
 * twelve-record view with three pages in it, and asserts what the control did —
 * both what it rendered and what it asked the platform for.
 *
 * Why it exists alongside `npm start` and `dev/harness.html`: half of what a
 * dataset control does is ask the platform for things, and a rendered table
 * shows none of it. Whether a sort *replaced* the order or appended to it,
 * whether a page turn asked for page two or for "one more page", whether a page
 * size change settles or loops — those are decisions, they are what regresses,
 * and here they are assertions with an exit code.
 *
 * Why no test framework: there is none in this repository, and adding one to
 * run a handful of assertions against a bundle would be a dependency, a config
 * file and a second build pipeline for something `node` already does. It also
 * runs the **built bundle** rather than the TypeScript sources, which is the
 * part worth checking. CI runs it after the msbuild pack, so there it drives
 * the production bundle.
 *
 * **What passing here does NOT mean.** Every record below is supplied by this
 * file. It cannot tell you that a real view hands over what this fixture hands
 * over, that server-side sorting sorts the same way, that `openDatasetItem`
 * opens anything, or that the control looks right. Keep those in SPEC.md under
 * "Not verified".
 *
 * **The quirks default to the platform's observed misbehaviour, not to its
 * documentation**, and that is load-bearing. See the header of `dev/host.js`:
 * a harness modelling the platform as written down passes a control that cannot
 * page on a real form.
 *
 * ---
 *
 * **The assertions below the divider are a worked example. Replace them.**
 * Everything above the divider is plumbing that works for any dataset control;
 * the examples exercise the scaffolded table and are meant to be thrown away
 * with it.
 */

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const dom = require('../dom.js');
const host = require('./host.js');
const clock = require('../clock.js');
const fixture = require('./fixture.js');

const BUNDLE = path.join(root, 'out', 'controls', 'LinkColumn', 'bundle.js');

if (!fs.existsSync(BUNDLE)) {
    console.error('\n  No bundle at out/controls/LinkColumn. Run npm run build first.\n');
    process.exit(1);
}

/* ----------------------------------------------------------- the platform */

dom.install(global);

/*
 * Time, replaced with something the test drives.
 *
 * `vm.runInThisContext` below evaluates the bundle in *this* realm, so the
 * `Date`, `setInterval` and `setTimeout` the control closes over are the ones
 * installed here — no injectable clock parameter, and therefore no production
 * code bent to suit a harness.
 *
 * A dataset control is likelier to want a timer than a field control is: an
 * auto-refreshing view, a debounce around `dataset.refresh()`, a countdown in a
 * cell. A control with none is unaffected — nothing schedules and
 * `time.pending()` stays at zero — but the teardown assertion at the bottom of
 * this file is written against it either way.
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
 * Fluent is stubbed rather than loaded: every component resolves to its own
 * name as an element type, so the props the control passed survive for
 * inspection. These assertions are about the control's decisions, not about how
 * Fluent renders them — and Fluent 9 ships no UMD build to load anyway.
 */
const fluent = new Proxy({}, { get: (_target, name) => (typeof name === 'string' ? name : undefined) });

fluentGlobals.forEach((name) => {
    global[name] = fluent;
});

vm.runInThisContext(source, { filename: 'bundle.js' });

/**
 * Render what a virtual control returned, executing the component body.
 *
 * **`updateView` only *builds* an element.** A virtual control's component does
 * not run until something renders it, so an assertion that reads props alone
 * cannot see a crash inside the component — and half of what a React dataset
 * control does lives there. That is not hypothetical: the `dataset.sorting`
 * crash below is in the component, and a props-only suite passes against the
 * broken control.
 *
 * `react-dom/server` needs no DOM and no browser. Fluent is stubbed, so its
 * components render as their own names and the markup is meaningless — the
 * point is entirely whether rendering threw.
 *
 * Returns `null` for a standard control, which has no element and no react-dom.
 */
function renderDeep(element) {
    if (element === undefined || element === null || React === null) {
        return null;
    }

    let server = null;

    try {
        server = require(path.join(root, 'node_modules', 'react-dom', 'server'));
    } catch (error) {
        return null;
    }

    // React's development warnings about unknown element types would bury the
    // report; the assertions are about throwing, not about tag names.
    const warn = console.error;
    console.error = () => {};

    try {
        return server.renderToStaticMarkup(element);
    } finally {
        console.error = warn;
    }
}

/* ---------------------------------------------------------------- harness */

const results = [];

function check(label, ok, detail) {
    results.push({ ok, label, detail });
}

// `getString` returns a marked key rather than a real string, so an assertion
// can tell "read from the .resx" apart from "hardcoded in the source".
const marked = (key) => `resx:${key}`;

/**
 * Bind a fresh control to a fresh view and render until it settles.
 *
 * The returned handle exposes both halves: what was drawn (or, for a virtual
 * control, what was passed down), and what the platform was asked to do.
 */
/**
 * Every control bound and not yet destroyed.
 *
 * A suite that binds and walks away is testing something other than what it
 * says: an abandoned control keeps its interval and its `document` listeners,
 * so the next section's counts include them. That is the leak the teardown
 * assertion exists to catch, and asserting it from inside one proves nothing.
 */
const live = [];

function disposeAll() {
    while (live.length > 0) {
        live.pop().destroy();
    }
}

function bind(options) {
    const handle = host.createHost(fixture, { getString: marked, ...options });
    const container = dom.createElement('div');
    const instance = new registration.ctor();

    let notifications = 0;

    instance.init(handle.context, () => {
        notifications += 1;
    }, {}, container);

    let driven = host.drive(instance, handle, 10);

    const view = {
        instance,
        container,
        handle,
        get driven() {
            return driven;
        },
        /** The props a virtual control passed down; `{}` for a standard one. */
        props: () => (driven.element && driven.element.props) || {},
        calls: () => handle.state.calls,
        /** How many times the control said its outputs changed. */
        notifications: () => notifications,
        outputs: () => (instance.getOutputs ? instance.getOutputs() : {}),
        find: (selector) => container.querySelector(selector),
        findAll: (selector) => container.querySelectorAll(selector),
        /** Let the platform catch up after something the control asked for. */
        settle: () => {
            driven = host.drive(instance, handle, 10);

            return driven;
        },
        /** Unmount, as the platform does when the form closes or navigates. */
        destroy: () => {
            instance.destroy();

            const at = live.indexOf(view);

            if (at !== -1) {
                live.splice(at, 1);
            }
        },
    };

    live.push(view);

    return view;
}

check('bundle registered a control', typeof registration.ctor === 'function');

if (typeof registration.ctor !== 'function') {
    report();
}

/* ======================================================================== *
 *  WORKED EXAMPLE — replace everything below with assertions about your own
 *  control. It exercises the scaffolded table: sortable headers, a pager, and
 *  an open-record button on the primary column.
 *
 *  The four adapters below are what let one set of assertions read both
 *  shapes. A **standard** control writes a table into its container, so they
 *  read the DOM; a **virtual** one returns an element, so they read the props
 *  it passed down. Keeping the assertions shape-neutral is not only
 *  convenience — it is what makes them about the control's *decisions* rather
 *  than about its markup, and the decisions are the part that regresses.
 * ======================================================================== */

const isVirtual = bind({}).driven.element !== undefined;

/** The column display names the control chose to show, in the order it chose. */
const columnsOf = (view) =>
    isVirtual
        ? (view.props().columns || []).map((column) => column.displayName)
        : view.findAll('th').map((th) => th.textContent);

/** How many records ended up on the page. */
const rowsOn = (view) => {
    if (isVirtual) {
        return (view.props().pageIds || []).length;
    }

    const body = view.container.querySelector('tbody');

    return body ? body.children.length : 0;
};

/** The page the control believes it is on. */
const pageOf = (view) => {
    if (isVirtual) {
        return view.props().page;
    }

    // A standard control keeps its counter to itself, so the pager label is the
    // only place it surfaces. That is a real difference between the shapes
    // rather than a gap in this file.
    const status = view.find('.LinkColumn-pagerStatus');

    return status ? status.textContent : '';
};

/** Turn the page forward the way a user would, then let the platform catch up. */
const turnNext = (view) => {
    if (isVirtual) {
        view.props().onNextPage();
    } else {
        view.find('.LinkColumn-next').click();
    }

    return view.settle();
};

/** Sort by a column the way a user would. */
const sortBy = (view, columnName, index) => {
    if (isVirtual) {
        view.props().onSort(columnName);
    } else {
        view.findAll('.LinkColumn-sort')[index].click();
    }

    return view.settle();
};

const view = bind({});

/*
 * A control that mutates in `updateView` without a guard never stops, and the
 * limit being reached is the loop.
 *
 * **One pass, where this used to be two.** The second pass was the page size:
 * the property carried `default-value="25"`, so every mount called
 * `setPageSize` and `refresh()` and cost a round trip — while replacing the
 * *Rows per page* the user had set on the grid. With no default there is
 * nothing to ask for, and the control settles on the first pass.
 */
check(
    'settles instead of refreshing forever',
    !view.driven.looping && view.driven.passes === 1,
    `${view.driven.passes} passes, calls: ${view.calls().join(' ')}`,
);

/*
 * The assertion about a call that must **not** happen — `pcf-row-commands`
 * shipped this override and had to be released twice to take it back out.
 */
check(
    'an unset page size overrides nothing — the host is already paging',
    view.calls().filter((call) => call.startsWith('setPageSize')).length === 0,
    view.calls().join(' '),
);

const overriding = bind({ inputs: { pageSize: 3 } });

check(
    'a page size the maker did set is asked for once and then left alone',
    overriding.calls().filter((call) => call.startsWith('setPageSize')).length === 1,
    overriding.calls().join(' '),
);

/*
 * A main grid answers the width and never the height — `-1` for the life of the
 * control, however politely it asks. A control that waits for a positive number
 * waits forever, which is how `pcf-row-commands` ran its rows off the bottom of
 * a page and took the pager with them.
 */
const unmeasured = bind({ width: 900, quirks: { heightUnmeasured: true } });

check(
    'renders on a host that measures a width and never a height',
    unmeasured.handle.context.mode.allocatedHeight === -1 && !unmeasured.driven.looping,
    `allocatedHeight ${unmeasured.handle.context.mode.allocatedHeight}`,
);

/*
 * `isHidden` and `order` are the maker's decisions in the view designer. The
 * fixture supplies its columns out of order and marks one hidden, so a control
 * that uses `dataset.columns` as handed over fails both of these.
 */
check('shows only the columns the maker left visible', columnsOf(view).length === 5, columnsOf(view).join(' | '));

check(
    'in the order the view designer set, not the order the array arrived in',
    columnsOf(view)[0] === 'Account name' && columnsOf(view)[1] === 'Account number',
    columnsOf(view).join(' | '),
);

/* ------------------------------------------------------------------ paging */

check(
    'shows one page of records, not the whole view',
    rowsOn(view) === 5,
    `${rowsOn(view)} rows for a page size of 5 over 12 records`,
);

const paged = bind({});
turnNext(paged);

/*
 * **The assertion the whole file is for.**
 *
 * With `accumulatePages` on — the observed platform behaviour, and the default
 * — `sortedRecordIds` holds page one *and* page two after a forward page. A
 * control that uses the array it was given shows ten records here, with page
 * two stacked under page one, and looks completely correct against any
 * single-page fixture. Every dataset control on the hub is stuck at fidelity
 * "limited" precisely because no harness could produce this state.
 */
check(
    'page two replaces page one rather than stacking under it',
    rowsOn(paged) === 5,
    `${rowsOn(paged)} rows on page 2; the platform handed over ${paged.handle.dataset.sortedRecordIds.length} ids`,
);

/*
 * `hasPreviousPage` stays false on a real form after paging forward, so a pager
 * driven by it can go forward and never come back. The control counts pages
 * itself for this reason, and this is what proves it does.
 */
check(
    'knows it is on page two even though the platform reports no previous page',
    isVirtual ? pageOf(paged) === 2 : paged.find('.LinkColumn-previous').disabled === false,
    `hasPreviousPage: ${paged.handle.dataset.paging.hasPreviousPage}; page: ${pageOf(paged)}`,
);

check(
    'turning a page asks for that page by number',
    paged.calls().some((call) => call.indexOf('loadExactPage(2)') === 0),
    paged.calls().join(' '),
);

/*
 * `loadExactPage` is typed as required, which is a claim about the type
 * definitions rather than about the host. A control that calls it unguarded
 * throws on a host that does not have it.
 */
const noExact = bind({ quirks: { hasLoadExactPage: false } });
let fellBack = true;

try {
    turnNext(noExact);
} catch (error) {
    fellBack = false;
}

check(
    'pages without loadExactPage rather than throwing',
    fellBack && noExact.calls().some((call) => call.indexOf('loadNextPage') === 0),
    noExact.calls().join(' '),
);

/*
 * The pager chevrons are inline `<svg>`, and that is a theming decision.
 *
 * The same glyph behind an `<img src>` — a resource, a data URL, PNG or SVG
 * alike — renders in an isolated document that cannot see the control’s
 * stylesheet, so its `currentColor` resolves to black and a dark form gets a
 * black chevron on a dark background. A control in this house shipped exactly
 * that, and it was found on a real form rather than in review.
 *
 * A virtual control has no DOM here, so this reads the rendered markup instead.
 */
if (isVirtual) {
    const markup = renderDeep(view.driven.element) || '';

    check(
        'the pager renders inline svg chevrons, not images',
        (markup.match(/<svg/g) || []).length === 2 && !markup.includes('<img'),
        `${(markup.match(/<svg/g) || []).length} svg, ${(markup.match(/<img/g) || []).length} img`,
    );
} else {
    for (const [what, selector] of [['previous', '.LinkColumn-previous'], ['next', '.LinkColumn-next']]) {
        // A tag selector scoped to the button: `dev/dom.js` supports 'tag',
        // '.class' and 'tag.class', and throws by name on anything else.
        const button = view.find(selector);
        const glyph = button && button.querySelector('svg');

        check(
            `the ${what} button carries an inline svg chevron, not an image`,
            glyph !== null && glyph.tagName.toLowerCase() === 'svg',
            glyph ? glyph.tagName : 'no svg found',
        );
    }
}

/* ----------------------------------------------------------------- sorting */

const sorted = bind({});

sortBy(sorted, 'name', 0);
sortBy(sorted, 'accountnumber', 1);
sortBy(sorted, 'statecode', 2);

/*
 * `dataset.sorting` is the whole ORDER BY and it is mutated in place, so a
 * control that pushes instead of replacing builds a three-deep sort nobody
 * asked for — invisible against a fixture small enough that the first column
 * decides every comparison.
 */
check(
    'sorting a third column replaces the order rather than appending to it',
    sorted.handle.dataset.sorting.length === 1,
    `${sorted.handle.dataset.sorting.length} sort entries after three clicks`,
);

check(
    'a new order sends the reader back to page one',
    sorted.calls().some((call) => call === 'paging.reset'),
    sorted.calls().join(' '),
);

/*
 * **The host that supplies no sorting array at all, which is `npm start`.**
 *
 * Its dataset mock sets `sorting: undefined` while the type definitions call it
 * required, so `dataset.sorting.find(...)` throws — and the harness *swallows*
 * the TypeError. The control renders as an empty box with nothing in the
 * console, which is the worst possible first impression of a freshly scaffolded
 * dataset control, and it is what the scaffolded one did until this assertion
 * existed.
 *
 * Verified against pcf-start 1.51.1 by instrumenting the control and reading
 * the dataset it was handed: `typeof dataset.sorting === "undefined"`, three
 * columns, three records, `isVisible: true` — everything present to render a
 * table, and a blank container.
 *
 * Keep this even if you delete every other assertion in the file. It costs one
 * `?? []` in the control and it is the difference between `npm start` working
 * and `npm start` looking broken.
 */
/*
 * Caught rather than allowed to propagate, because the failure this guards
 * against is a *throw* — and an uncaught one here would end the run with a
 * stack trace instead of a named failing check. A suite that explodes tells you
 * less than one that fails.
 */
let unsorted = null;
let renderError = null;

try {
    unsorted = bind({ quirks: { sortingAbsent: true } });
    // Deep, not shallow: for a virtual control the crash is inside the
    // component, which building the element does not execute.
    renderDeep(unsorted.driven.element);
} catch (error) {
    renderError = `${error.constructor.name}: ${error.message}`;
}

check(
    'renders on a host that supplies no sorting array (npm start does not)',
    renderError === null
        && unsorted !== null
        && (isVirtual ? unsorted.driven.element !== undefined : Boolean(unsorted.find('table'))),
    renderError ? `threw during render — ${renderError}` : 'sorting was undefined',
);

// And a sort click on such a host declines rather than throwing: there is no
// array to express the order through, and the local harness cannot sort anyway.
let sortError = null;

if (unsorted) {
    try {
        sortBy(unsorted, 'name', 0);
    } catch (error) {
        sortError = `${error.constructor.name}: ${error.message}`;
    }
}

check(
    'and declines a sort it has no way to express, rather than throwing',
    unsorted !== null && sortError === null,
    sortError || undefined,
);

/* --------------------------------------------------------------- filtering */

/*
 * **The host that supplies no `dataset.filtering`.**
 *
 * Same shape as the sorting assertion above, one step less certain: the type
 * definitions declare `filtering` as always present, so a control that calls
 * `dataset.filtering.setFilter(...)` has taken them at their word. The
 * scaffolded table never filters, so this passes for free — and starts earning
 * its keep the first time somebody adds a search box.
 */
let unfiltered = null;
let filterRenderError = null;

try {
    unfiltered = bind({ quirks: { filteringAbsent: true } });
    renderDeep(unfiltered.driven.element);
} catch (error) {
    filterRenderError = `${error.constructor.name}: ${error.message}`;
}

check(
    'renders on a host that supplies no filtering object',
    filterRenderError === null && unfiltered !== null,
    filterRenderError ? `threw during render — ${filterRenderError}` : 'filtering was undefined',
);

/*
 * The stand-in's own contract, asserted here rather than assumed by whoever
 * writes the first control that filters. Three facts, and each is one a real
 * platform enforces:
 *
 *   1. `setFilter` alone changes nothing. `refresh()` is the fetch, and a
 *      control that omits it must see its rows stay exactly as they were —
 *      otherwise this file would pass a control that never refreshes.
 *   2. Once fetched, the filter is the server's result set, so
 *      `totalResultCount` follows it. A control that prints the view's total
 *      under a filter is reading a number it was never given.
 *   3. Filtering does **not** reset the page. Staying on page three of a result
 *      set that now has one page is the control's bug to avoid, and this file
 *      would rather reproduce it than paper over it.
 */
const rig = host.createHost(fixture, { pageSize: 5 });
const before = rig.dataset.paging.totalResultCount;

rig.dataset.filtering.setFilter({
    filterOperator: host.OR,
    conditions: [{ attributeName: 'name', conditionOperator: host.OPERATOR.Like, value: 'contoso%' }],
});

const beforeRefresh = rig.dataset.paging.totalResultCount;

rig.dataset.refresh();

check(
    'a filter that was set but never refreshed moves nothing',
    beforeRefresh === before,
    `${before} → ${beforeRefresh} without a refresh`,
);

check(
    'and once refreshed, the total is the filtered total',
    before === 12 && rig.dataset.paging.totalResultCount < before,
    `${before} → ${rig.dataset.paging.totalResultCount}`,
);

check(
    'filtering leaves the page where it was — resetting it is the control’s job',
    rig.state.page === 1 && !rig.state.calls.includes('paging.reset'),
    rig.state.calls.join(' '),
);

/* ------------------------------------------------------------ the counters */

/*
 * `totalResultCount` is -1 when the platform did not count the rows, which is
 * common on large views. "of -1" is the tell that nobody checked.
 *
 * A virtual control hands the count to its component rather than formatting it,
 * so the assertion is about what it passed down.
 */
const uncounted = bind({ quirks: { uncounted: true } });

check(
    'never prints a total the platform said it does not have',
    isVirtual
        ? uncounted.props().pageIds !== undefined
        : uncounted.find('.LinkColumn-pagerStatus').textContent.indexOf('-1') === -1,
    !isVirtual && uncounted.find('.LinkColumn-pagerStatus').textContent,
);

/* ------------------------------------------------------------- the states */

/*
 * `loading` is true on the first `updateView`, before any records arrive, so a
 * control that renders the empty state here flashes "No records" on every load.
 *
 * A standard control writes the message itself; a virtual one passes the
 * dataset down and lets the component decide, so only the first can be asserted
 * from here. That is a real difference between the shapes, and a virtual
 * control's equivalent assertion belongs in a component test — which this
 * repository does not have, and which is worth saying out loud rather than
 * papering over.
 */
if (!isVirtual) {
    check(
        'says it is loading rather than saying there is nothing',
        bind({ loading: true, records: [] }).find('.LinkColumn-message').textContent
            === 'resx:LinkColumn_Loading',
    );

    check(
        'and says there is nothing once loading is done',
        bind({ records: [] }).find('.LinkColumn-message').textContent === 'resx:LinkColumn_Empty',
    );

    check(
        'reports an error the platform handed down',
        bind({ error: true }).find('.LinkColumn-message').textContent
            === 'The records could not be loaded.',
    );

    /*
     * A canvas app supplies only the columns picked in the Items Fields
     * flyout. None picked is a real state, and an empty table reads as a broken
     * control rather than as an unfinished configuration.
     */
    check(
        'tells the maker when no columns have been chosen',
        bind({ columns: [] }).find('.LinkColumn-message').textContent === 'resx:LinkColumn_NoColumns',
    );

    check(
        'takes no position on the theme when the host publishes none',
        !bind({ host: 'canvas' }).container.classList.contains('LinkColumn--dark'),
    );
} else {
    check('an empty view produces no rows', rowsOn(bind({ records: [] })) === 0);

    check(
        'and a host that publishes no theme is passed none rather than a guess',
        bind({ host: 'canvas' }).props().theme === undefined,
    );
}

/* ---------------------------------------------------- what destroy owes */

/*
 * **Keep this when the worked example above goes.** It is written against no
 * particular control and needs no knowledge of what yours takes.
 *
 * `destroy` is the lifecycle method with nothing visible riding on it, so it is
 * the one that quietly does nothing. A control that takes an interval, a
 * `requestAnimationFrame` loop, or a listener on `document` or `window` owes
 * each of them back — and none of the three shows up on a form. The interval
 * keeps firing against a container the platform has already thrown away; the
 * document listener keeps the whole control reachable, so nothing about it is
 * ever collected.
 *
 * A dataset control makes this worse than a field control does. It is the shape
 * that ends up on a subgrid, in a gallery, or on a form the user navigates
 * between records on — so it is mounted and unmounted repeatedly, and each pass
 * leaves whatever the last one did not release.
 *
 * Counting before and after is the whole trick. The scaffolded control takes
 * neither a timer nor a listener, so both numbers are zero and this passes
 * trivially — which is the point: it starts passing for a real reason the
 * moment somebody adds a refresh timer, and fails the moment they forget the
 * other half.
 */
disposeAll();

const timersBefore = time.pending();
const listeners = () => Object.values(dom.document.listeners).reduce((total, list) => total + list.length, 0);
const listenersBefore = listeners();

bind({}).destroy();

check(
    'destroy() releases every timer the control took',
    time.pending() === timersBefore,
    `${timersBefore} → ${time.pending()}`,
);

check('and every document-level listener', listeners() === listenersBefore, `${listenersBefore} → ${listeners()}`);

/*
 * The other half, and the leak this shape is famous for. `updateView` runs on
 * every change to any bound value — and on a dataset control it runs again
 * every time the platform finishes a page, a sort or a filter, which is far
 * more often than a field control sees. A `setInterval` reached from the render
 * path adds a timer per pass rather than replacing one.
 */
const rerendered = bind({});
const afterFirst = time.pending();

rerendered.settle();
rerendered.settle();
rerendered.settle();

check('and re-rendering does not add another one', time.pending() === afterFirst, `${afterFirst} → ${time.pending()}`);


/* ------------------------------------------------- the link column */

/*
 * The same allow-list as `LinkField`, proven in a grid.
 *
 * Both controls import `shared/url.ts`, so this is not a second implementation
 * of the rule — but a boundary is only as strong as its weakest caller, and the
 * caller here is different code deciding *whether to call it at all*. The
 * fixture carries a `javascript:` and a `data:` row for exactly that reason.
 */
const linked = bind({});

const anchors = () => linked.container.querySelectorAll('a.LinkColumn-link');
const hrefs = () => anchors().map((a) => a.getAttribute('href'));

check(
    'a followable cell becomes a link',
    hrefs().indexOf('https://www.fabrikam.example.com/about') !== -1,
    hrefs().join(' | '),
);

check(
    'and shows the site name, not the raw address',
    anchors().some((a) => a.textContent === 'fabrikam.example.com'),
    anchors().map((a) => a.textContent).join(' | '),
);

check(
    'a hostile scheme is never given an anchor',
    !hrefs().some((href) => /^(javascript|data|vbscript):/i.test(href || '')),
    hrefs().join(' | '),
);

check(
    'a bare hostname is not a link either — it has no scheme to trust',
    !hrefs().some((href) => (href || '').indexOf('litware') !== -1),
    hrefs().join(' | '),
);

check(
    'a null and an empty cell render as text, not as an empty link',
    anchors().every((a) => (a.textContent || '') !== ''),
    anchors().map((a) => JSON.stringify(a.textContent)).join(' | '),
);

/*
 * Through the platform, not the href — the same reason as on a form. Inside
 * a model-driven grid an unprevented click navigates the form's own iframe.
 */
const cellLink = anchors().filter((a) => a.getAttribute('href') === 'https://contoso.example.com')[0];

if (cellLink) {
    cellLink.dispatchEvent({ type: 'click', target: cellLink, preventDefault: function () {} });
}

check(
    'clicking a cell link goes through navigation.openUrl',
    linked.calls().some((call) => call.indexOf('navigation.openUrl("https://contoso.example.com")') === 0),
    linked.calls().filter((c) => c.indexOf('navigation.openUrl') === 0).join(' | ') || '(no openUrl calls)',
);

disposeAll();


/*
 * **Repaginating resets the page, and applying the first size does not.**
 *
 * A page size that changes *after* one has been applied recuts the result
 * set, so "page 3" stops meaning what it meant and the platform answers a
 * request for it with nothing. The first application is the other case: at
 * mount the platform is already on page one, and `reset()` is itself a
 * fetch — so resetting there buys a round trip for nothing.
 *
 * Mutating the maker's input mid-flight is the only way to reach this from
 * a suite. The property is read fresh from `options.inputs` on every pass,
 * so this models a property edited in the form designer — which is the only
 * way the size changes in this control, and why the omission went unnoticed
 * here until `pcf-data-table` found it with a rows-per-page picker.
 */
const repaginated = bind({ inputs: { pageSize: 4 } });
const resets = () => repaginated.calls().filter((call) => call === 'paging.reset').length;
const resetOnMount = resets();

repaginated.handle.options.inputs.pageSize = 9;
repaginated.settle();

check(
    'the first page size costs no reset, and changing it afterwards does',
    resetOnMount === 0 && resets() === 1,
    `${resetOnMount} at mount, ${resets()} after the change`,
);

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
            : `\n  ${results.length} passed — the control's own decisions only; see SPEC.md for what a real view still has to confirm\n`,
    );

    process.exit(failed.length > 0 ? 1 : 0);
}
