/*
 * The platform, stood in for: a working `DataSet` with real paging, real
 * sorting and real filtering, plus the switches for the ways a real one
 * misbehaves.
 *
 * Loaded by both `harness.html` in a browser and `smoke.js` in Node, which is
 * why it attaches to `window` *and* assigns `module.exports` and requires
 * neither to exist.
 *
 * ---
 *
 * **Why this exists.** Every dataset control in the catalogue is published at
 * `demo.fidelity: "limited"` for the same reason: the hub's harness seeds a
 * single page, reports no next or previous page, and discards sorting between
 * renders. `npm start` is not much better — it will bind a CSV, but it will not
 * put the control on page three of a sorted view and then change the page size
 * underneath it.
 *
 * So the paging and sorting code in a dataset control — which is most of the
 * hard code in a dataset control — has never been exercised by anything before
 * this file. It ships with twelve records and a page size of five for exactly
 * that reason: three pages is the smallest number that tells you whether page
 * two came from the platform or from a slice.
 *
 * Filtering is thinner still everywhere else: the hub's harness and `npm start`
 * both accept a `setFilter` call and discard it, so a filtered view is one of
 * the few things a control can get *completely* wrong and still demo. Here the
 * expression is applied, the counts follow it, and forgetting the `refresh()`
 * afterwards shows up as a set of rows that did not change.
 *
 * ---
 *
 * **The `quirks` switches are the point, not a curiosity.**
 *
 * The scaffolded control carries three repairs for behaviour observed on a real
 * model-driven form, and each one looks like superstition until you can turn
 * the behaviour on:
 *
 *   - `loadNextPage(true)` **ignores its argument** and hands back the whole
 *     range from page one, so `sortedRecordIds` accumulates instead of
 *     replacing. This is why the control slices.
 *   - `hasPreviousPage` **stays false** after paging forward, so a pager driven
 *     by it can never go back. This is why the control counts pages itself.
 *   - `firstPageNumber` **disagrees with the ids**, which is how a range like
 *     "4–9 of 6" gets printed. This is why the label is built from the
 *     control's own counter.
 *
 * Default them to the observed behaviour, not the documented one. A harness
 * that models the platform as it is written down will pass a control that
 * cannot page on a real form — which is the exact failure these switches exist
 * to prevent.
 *
 * ---
 *
 * **A stub must never be more capable than the thing it stands in for.**
 * `refresh()` here does not re-render; it records that a render is owed, and
 * the driver decides when to run it. That is deliberate. A `refresh()` that
 * re-entered `updateView` immediately would hide the loop a guarded mutator
 * exists to prevent, and would make an infinite one look like a hang instead of
 * a count.
 */

(function (root, factory) {
    'use strict';

    var api = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }

    if (root) {
        root.__pcfHost = api;
    }
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    /** `SortDirection` is a numeric union: 0 ascending, 1 descending. */
    var ASCENDING = 0;
    var DESCENDING = 1;

    /**
     * `FilterOperator`, which combines the conditions of one expression.
     *
     * 0 And, 1 Or — and the default matters: an expression that omits
     * `filterOperator` is `And`, so a search that meant "this term in any of
     * four columns" and forgot to say `Or` matches nothing and looks like a
     * broken query rather than a missing field.
     */
    var AND = 0;
    var OR = 1;

    /**
     * The `ConditionOperator` values this stand-in honours, out of the ~90 the
     * platform defines.
     *
     * These five are the ones a control can use on **both** hosts. The rest of
     * the enum is where the hosts disagree, and the disagreement is not
     * symmetric: `NotLike` (7) and `NotNull` (13) are canvas-only, while
     * `Yesterday` (14), `Today` (15) and `Tomorrow` (16) are model-driven-only.
     * A control that reaches past this object is choosing a host, and should
     * say so in `docs/limitations.md`.
     */
    var OPERATOR = { Equal: 0, NotEqual: 1, GreaterThan: 2, LessThan: 3, Like: 6, Null: 12 };

    var STRINGS = {
        LinkColumn_Name: 'Link Column',
        LinkColumn_Empty: 'No records.',
        LinkColumn_Error: 'The records could not be loaded.',
        LinkColumn_Loading: 'Loading…',
        LinkColumn_NoColumns: 'No columns have been chosen for this control.',
        LinkColumn_Next: 'Next',
        LinkColumn_Previous: 'Previous',
        LinkColumn_OpenRecord: 'Open {0}',
        LinkColumn_SortBy: 'Sort by {0}',
        LinkColumn_PageStatus: 'Page {0}',
        LinkColumn_RangeStatus: '{0}–{1} of {2}',
    };

    var HOSTS = {
        'model-driven': { label: 'model-driven form', publishesTheme: true },
        canvas: { label: 'canvas app', publishesTheme: false },
    };

    /**
     * `context.client.getFormFactor()`, which is a number and not the one most
     * people guess.
     *
     * **0 Unknown, 1 Desktop, 2 Tablet, 3 Phone.** Web is `1`, and `3` — the
     * value that looks like it ought to mean "the big one" — is a phone. A
     * dataset control that drops columns on a narrow client is comparing
     * against one of these, and comparing against the wrong one drops them
     * everywhere except where it meant to.
     */
    var FORM_FACTORS = { unknown: 0, desktop: 1, tablet: 2, phone: 3 };

    var DEFAULTS = {
        host: 'model-driven',
        formFactor: 'desktop',
        /**
         * `mode.allocatedWidth` / `allocatedHeight`.
         *
         * **-1 until the control calls `mode.trackContainerResize(true)`**, and
         * that is the default here because it is the platform's. A table that
         * decides its column widths from a width it never asked for lays out
         * against -1 on every host.
         */
        width: -1,
        height: -1,
        pageSize: 5,
        visible: true,
        /** `mode.isControlDisabled` — a read-only form, or a canvas DisplayMode. */
        disabled: false,
        dark: undefined,
        rtl: false,
        /** No records yet, which is the state of the first `updateView`. */
        loading: false,
        error: false,
        errorMessage: 'The records could not be loaded.',
        /** Replace with `[]` to see the empty state, or with a subset. */
        records: null,
        columns: null,

        /**
         * The control's own input properties, merged into `parameters`.
         *
         * The scaffolded control has only `pageSize`, and every real one grows
         * more. Pass them as raw values — `{ selectionMode: 'multiple' }` — and
         * they arrive as `{ raw: … }` where the control expects them.
         *
         * Passing them rather than editing this file is what keeps a repo's
         * copy of the rig close enough to the template's to update by copying.
         */
        inputs: {},

        /**
         * Whether `context.webAPI` exists at all.
         *
         * Absent is a real host and it is the reason a control declares
         * `<uses-feature required="false">`: WebAPI is Dataverse-dependent and is
         * not available in canvas apps, so a control that reaches for it
         * unguarded works everywhere it was tested and nowhere else.
         */
        webAPI: true,

        /**
         * Whether `context.navigation.openFile` exists.
         *
         * Separate from `webAPI` because it is absent for a different reason:
         * `openFile` is documented model-driven apps only, while
         * `context.navigation` itself is present either way. A control that
         * checks the bag rather than the method passes on a host that cannot
         * open a file.
         */
        openFile: true,

        /**
         * Whether `context.navigation` exists at all.
         *
         * Typed non-optional, which is a claim about the type definitions
         * rather than about the host — the same claim `loadExactPage` and
         * `setFullScreen` make, and the reason both have a switch. A control
         * that reads `context.navigation.openForm` through an unguarded bag
         * throws a TypeError rather than degrading, and a rig that cannot
         * remove the bag cannot tell the two apart.
         */
        hasNavigation: true,

        /**
         * Whether `webAPI.deleteRecord` rejects.
         *
         * A destructive call is the one place a rejection is not an edge case:
         * a delete fails on a cascade restriction, a missing privilege, or a
         * record somebody else already removed, and all three are ordinary.
         * The rejection is a plain object carrying `errorCode` and `message`,
         * never an `Error` — see the note on `retrieveRecord` below.
         */
        webApiFails: false,

        /**
         * What the platform dialogs do, and there are four answers rather than
         * two.
         *
         *   'confirmed' -> `openConfirmDialog` resolves `{ confirmed: true }`
         *   'cancelled' -> resolves `{ confirmed: false }` — **a resolve, not a
         *                  reject.** A control that treats a cancel as a
         *                  failure reports an error the user did not cause,
         *                  and this is the single easiest thing to get wrong
         *                  about the dialog API.
         *   'rejected'  -> the promise rejects, which is what a dialog the host
         *                  refuses to open does
         *   'absent'    -> the three dialog methods are **deleted from the
         *                  bag**, which is what canvas is. Absence is a
         *                  different state from refusal — it is the state
         *                  `<uses-feature required="false">` is actually about
         *                  — and `pcf-geo-stamp` found that out the hard way on
         *                  the device APIs.
         */
        dialogs: 'confirmed',

        quirks: {
            /**
             * `loadNextPage(true)` returns the whole range from page one rather
             * than only the new page. Observed on a real form; defaulted on
             * because that is what a real form does.
             */
            accumulatePages: true,
            /** `hasPreviousPage` never becomes true. Observed on a real form. */
            previousPageStuck: true,
            /** `totalResultCount` is -1 — common on large views. */
            uncounted: false,
            /**
             * Whether `paging.loadExactPage` exists at all. It is typed as
             * required, which is a claim about the type definitions rather than
             * about the host, so a control that calls it unguarded is worth
             * being able to break here.
             */
            hasLoadExactPage: true,

            /**
             * Whether `dataset.addColumn` exists at all.
             *
             * Typed optional in @types/powerapps-component-framework, which is
             * the rare case of the type definitions being honest — so a control
             * that calls it unguarded is worth being able to break here.
             */
            hasAddColumn: true,

            /**
             * Whether `mode.setFullScreen` exists at all. The same claim as
             * `loadExactPage` makes: typed as always present, which is a
             * statement about the type definitions rather than about the host,
             * so a control that calls it unguarded is worth being able to break
             * here. Canvas is the known case.
             */
            hasFullScreen: true,

            /**
             * Whether `dataset.sorting` exists at all.
             *
             * **This one is not hypothetical, and it is not the platform — it
             * is `npm start`.** The local test harness's dataset mock sets
             * `sorting: undefined`, so `dataset.sorting.find(...)` throws a
             * TypeError that the harness swallows: the control renders as an
             * empty box with nothing in the console. A freshly scaffolded
             * dataset control did exactly that until this switch existed to
             * catch it.
             *
             * Off by default because a real form supplies the array — the
             * default models the platform, and the assertion in `smoke.js`
             * covers the one host known to deviate.
             */
            sortingAbsent: false,

            /**
             * `mode.allocatedHeight` stays -1 however the host is sized, and
             * however politely the control asks.
             *
             * **This is a main grid, and it is by design rather than a timing
             * problem.** A control on a table's main grid is handed a measured
             * *width* and never a height: `trackContainerResize(true)` changes
             * the width and leaves the height at -1 for the life of the control.
             *
             * It matters because "-1 means the host has not measured *yet*" is
             * the natural reading, and a control that waits for a positive
             * number waits forever. `pcf-row-commands` gated its scroll layout
             * on a measured height and ran twenty-five rows off the bottom of a
             * main grid, taking the pager — the only route to page two — with
             * them.
             *
             * Off by default, because a form subgrid does measure both.
             */
            heightUnmeasured: false,

            /**
             * Whether `dataset.filtering` exists at all.
             *
             * Same shape of risk as `sortingAbsent`, one step less certain: the
             * type definitions declare `filtering` as always present, and a
             * control that calls `dataset.filtering.setFilter(...)` without
             * checking has taken the types at their word. Turn this on to find
             * out what that costs before a host does it for you.
             *
             * Off by default, because a real form supplies it.
             */
            filteringAbsent: false,
        },
    };

    function formatted(value) {
        return value === null || value === undefined ? '' : String(value);
    }

    /**
     * Build the dataset and the context around it.
     *
     * The returned handle carries the engine's own view of the world —
     * `refreshes`, `calls`, the true page — so an assertion can be about what
     * the control *asked the platform to do*, which is the half that a rendered
     * table never shows.
     */
    function createHost(fixture, options) {
        var o = Object.assign({}, DEFAULTS, options || {});
        var quirks = Object.assign({}, DEFAULTS.quirks, (options || {}).quirks);
        var hostKind = HOSTS[o.host] || HOSTS['model-driven'];

        var allRecords = o.records || fixture.records;
        var columns = (o.columns || fixture.columns).slice();

        /**
         * Logical names handed to `addColumn` and not yet fetched.
         *
         * Requested rather than added, because that is what the platform does:
         * the column appears in the *next* result, not in the call. A stub that
         * added it synchronously would pass a control that never refreshed.
         */
        var requestedColumns = [];

        var state = {
            /** The page the platform believes it is on. */
            page: 1,
            /**
             * The page size actually in force, which is not the one most
             * recently requested — `setPageSize` does nothing until the next
             * fetch, and that gap is where a mutator loop lives.
             */
            pageSize: o.pageSize,
            requestedPageSize: o.pageSize,
            refreshes: 0,
            renderOwed: false,
            /** Every mutator the control called, in order, with its argument. */
            calls: [],
        };

        var sorting = [];

        /**
         * The selected ids, held rather than counted.
         *
         * This used to be a hardcoded `[]` with a `setSelectedRecordIds` that
         * logged only `ids.length`, which meant a control could set a selection
         * and read back nothing — so "selects the row it just acted on" was
         * unassertable and every control that tried looked correct while doing
         * nothing. The platform keeps the ids; so does this.
         */
        var selected = [];

        /**
         * The expression the control last set, and the one the data actually
         * reflects — which are not the same thing between a `setFilter` and the
         * `refresh()` that follows it.
         *
         * Two variables for the same reason `pageSize` and `requestedPageSize`
         * are two: filtering is server-side, so setting one changes nothing
         * until a fetch. **A control that calls `setFilter` and forgets
         * `refresh()` must see its rows stay exactly as they were**, because
         * that is what a real host does and it is the single easiest thing to
         * get wrong — a stub that filtered on `setFilter` alone would pass a
         * control that never refreshes.
         *
         * Once applied, the filter is the *server's* result set: the record
         * map, `totalResultCount` and `hasNextPage` all follow it. The reason a
         * control's pager breaks under a filter is almost always a total that
         * did not.
         */
        var requestedFilter = null;
        var filter = null;

        /**
         * Records deleted on the server, and records the client knows are gone.
         *
         * Two lists for the same reason `pageSize` and `requestedPageSize` are
         * two: a delete is a round trip, and the row does not leave the data
         * this control is holding until the next fetch. `deleteRecord` adds to
         * the pending list and `fetched()` moves it across — so **a control
         * that deletes and forgets `dataset.refresh()` sees the row still on
         * screen**, which is what a real form does and the single easiest thing
         * to get wrong. A stub that removed the row on the call would pass that
         * control.
         */
        var removedPending = [];
        var removed = [];

        function log(name, argument) {
            state.calls.push(argument === undefined ? name : name + '(' + JSON.stringify(argument) + ')');
        }

        /**
         * One `ConditionExpression` against one row.
         *
         * `Like` takes SQL wildcards rather than a substring — `dana%` is a
         * prefix match and `%dana%` a contains — and is case-insensitive, which
         * is Dataverse's default collation. A control that lowercases the term
         * itself and expects an exact match here is testing something the
         * server does not do.
         */
        function holds(row, condition) {
            var actual = row.values[condition.attributeName];
            var left = formatted(actual).toLowerCase();
            var right = formatted(condition.value).toLowerCase();

            switch (condition.conditionOperator) {
                case OPERATOR.Equal:
                    return left === right;
                case OPERATOR.NotEqual:
                    return left !== right;
                case OPERATOR.GreaterThan:
                    return Number(actual) > Number(condition.value);
                case OPERATOR.LessThan:
                    return Number(actual) < Number(condition.value);
                case OPERATOR.Null:
                    return actual === null || actual === undefined || actual === '';
                case OPERATOR.Like:
                    return likePattern(right).test(left);
                default:
                    /*
                     * Unhonoured operators pass rather than fail, so an
                     * assertion about a filter this file cannot model reads as
                     * "no filtering happened" instead of "everything vanished".
                     * The second is indistinguishable from a control that
                     * filtered its own rows away.
                     */
                    return true;
            }
        }

        function escapeForRegExp(part) {
            return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }

        /**
         * A SQL `LIKE` pattern as a regular expression.
         *
         * Three things are special and the third is the one people miss:
         * `%` is any run, `_` is any single character, and **`[c]` is a literal
         * `c`** — which is how a search term containing a wildcard is escaped,
         * because a backslash is not an escape character here.
         *
         * Without the bracket case a control that correctly escapes a typed `%`
         * to `[%]` looks broken against this stand-in while being right on the
         * server, which is the worst way for a harness to be wrong.
         */
        function likePattern(pattern) {
            var source = '^';

            for (var at = 0; at < pattern.length; at += 1) {
                var character = pattern.charAt(at);

                if (character === '[' && pattern.charAt(at + 2) === ']') {
                    source += escapeForRegExp(pattern.charAt(at + 1));
                    at += 2;
                } else if (character === '%') {
                    source += '.*';
                } else if (character === '_') {
                    source += '.';
                } else {
                    source += escapeForRegExp(character);
                }
            }

            return new RegExp(source + '$');
        }

        /** A `FilterExpression`, including any child `filters`, against one row. */
        function passes(row, expression) {
            if (!expression) {
                return true;
            }

            var conditions = expression.conditions || [];
            var children = expression.filters || [];

            var results = conditions
                .map(function (condition) {
                    return holds(row, condition);
                })
                .concat(
                    children.map(function (child) {
                        return passes(row, child);
                    }),
                );

            if (results.length === 0) {
                return true;
            }

            // Undeclared is `And` — see the note on FilterOperator above.
            var operator = expression.filterOperator === undefined ? AND : expression.filterOperator;

            return operator === OR ? results.some(Boolean) : results.every(Boolean);
        }

        /** Every record the current filter admits — the server's result set. */
        function matching() {
            var alive = removed.length === 0
                ? allRecords
                : allRecords.filter(function (row) {
                    return removed.indexOf(row.id) === -1;
                });

            return filter
                ? alive.filter(function (row) {
                    return passes(row, filter);
                })
                : alive;
        }

        /** All matching records in the order the current sort puts them. */
        function ordered() {
            var rows = matching().slice();

            if (sorting.length === 0) {
                return rows;
            }

            /*
             * Only the first entry is honoured, and that is not a shortcut: a
             * view's ORDER BY is what `dataset.sorting` holds, and a control
             * that pushes instead of replacing builds a three-deep sort nobody
             * asked for. Sorting by one column here makes that visible as a
             * wrong order rather than hiding it behind a stable tie-break.
             */
            var by = sorting[0];

            return rows.sort(function (a, b) {
                var left = formatted(a.values[by.name]);
                var right = formatted(b.values[by.name]);
                var compared = left.localeCompare(right);

                return by.sortDirection === DESCENDING ? -compared : compared;
            });
        }

        /**
         * What `sortedRecordIds` holds.
         *
         * With `accumulatePages` on — the observed platform behaviour — it is
         * every id from page one to the current page, which is why a control
         * that renders the array directly stacks page two under page one.
         */
        function visibleIds() {
            var rows = ordered();
            var end = state.page * state.pageSize;
            var start = quirks.accumulatePages ? 0 : (state.page - 1) * state.pageSize;

            return rows.slice(start, end).map(function (row) {
                return row.id;
            });
        }

        function recordFor(row) {
            return {
                getRecordId: function () {
                    return row.id;
                },
                getValue: function (name) {
                    return row.values[name];
                },
                getFormattedValue: function (name) {
                    /*
                     * A row may carry its own `formatted` bag, and it exists so a
                     * fixture can make the formatted value differ from the raw one
                     * — "$1,204.75" against 1204.75. Without that, a control that
                     * plots the formatted string and one that plots the number are
                     * indistinguishable from any assertion, and only one of them
                     * is right.
                     */
                    if (row.formatted && Object.prototype.hasOwnProperty.call(row.formatted, name)) {
                        return row.formatted[name];
                    }

                    return formatted(row.values[name]);
                },
                getNamedReference: function () {
                    return { id: row.id, name: formatted(row.values.name), etn: fixture.targetEntityType };
                },
            };
        }

        var filtering = {
            /*
             * Returns what was set, which is how a control tells "the filter I
             * am about to apply" from "the filter already in force". Without
             * that comparison, re-applying on every `updateView` is an
             * unbounded refresh loop — the one `drive()` counts passes to
             * catch.
             */
            getFilter: function () {
                return requestedFilter || undefined;
            },

            setFilter: function (expression) {
                log('filtering.setFilter', (expression && expression.conditions ? expression.conditions.length : 0));
                // Requested, not applied. Nothing changes until a fetch.
                requestedFilter = expression || null;
            },

            clearFilter: function () {
                log('filtering.clearFilter');
                requestedFilter = null;
            },
        };

        var dataset = {
            get columns() {
                return columns;
            },

            get sortedRecordIds() {
                return o.loading || o.error ? [] : visibleIds();
            },

            /*
             * Keyed by id and containing only the records of the current page,
             * because that is what the platform hands over — a control that
             * reaches for a record it was not given gets `undefined`, and the
             * scaffolded table's `if (!record) continue` is written for exactly
             * that.
             */
            get records() {
                var map = {};

                visibleIds().forEach(function (id) {
                    var row = allRecords.filter(function (candidate) {
                        return candidate.id === id;
                    })[0];

                    if (row) {
                        map[id] = recordFor(row);
                    }
                });

                return map;
            },

            /**
             * Mutated in place by the control. That is the documented API —
             * and `undefined` under `sortingAbsent`, which is what `npm start`
             * hands over.
             */
            get sorting() {
                return quirks.sortingAbsent ? undefined : sorting;
            },

            /**
             * Real filtering, and `undefined` under `filteringAbsent`.
             *
             * **Setting a filter is not a fetch.** `setFilter` records the
             * expression and not one row moves until the control calls
             * `refresh()` — which is the platform's contract and the half
             * people leave out, because a control that forgets the refresh
             * looks exactly like one whose filter did not match anything.
             *
             * Nor does it reset the page. Filter from page three and the
             * control is asking for page three of a result set that may have
             * one page in it; the platform will happily hand back nothing at
             * all. `paging.reset()` before `refresh()` is the control's job,
             * and leaving it out here is what makes the omission visible.
             */
            get filtering() {
                return quirks.filteringAbsent ? undefined : filtering;
            },

            paging: {
                get pageSize() {
                    return state.pageSize;
                },

                /*
                 * The *filtered* total, not the view's. A server counts what it
                 * returned; a control that filters and then prints "of 12" is
                 * reading a number the platform never gave it.
                 */
                get totalResultCount() {
                    return quirks.uncounted ? -1 : matching().length;
                },

                get hasNextPage() {
                    return state.page * state.pageSize < matching().length;
                },

                /*
                 * False after paging forward, as observed. The platform treats
                 * the load as the range 1..N, and a range beginning at page one
                 * truthfully has nothing before it — so a pager driven by this
                 * can go forward and never come back.
                 */
                get hasPreviousPage() {
                    return quirks.previousPageStuck ? false : state.page > 1;
                },

                /*
                 * Disagrees with the ids when pages accumulate: it reports the
                 * current page while `sortedRecordIds` holds every page up to
                 * it. A label that takes its start from here and its row count
                 * from the array prints a range past its own total.
                 */
                get firstPageNumber() {
                    return state.page;
                },

                setPageSize: function (size) {
                    log('setPageSize', size);
                    // Requested, not applied. Nothing changes until a fetch.
                    state.requestedPageSize = size;
                },

                loadNextPage: function (loadOnlyNewPage) {
                    log('loadNextPage', loadOnlyNewPage);
                    state.page += 1;
                    fetched();
                },

                loadPreviousPage: function (loadOnlyNewPage) {
                    log('loadPreviousPage', loadOnlyNewPage);
                    state.page = Math.max(1, state.page - 1);
                    fetched();
                },

                loadExactPage: quirks.hasLoadExactPage
                    ? function (page) {
                        log('loadExactPage', page);
                        state.page = Math.max(1, page);
                        fetched();
                    }
                    : undefined,

                reset: function () {
                    log('paging.reset');
                    state.page = 1;
                    fetched();
                },
            },

            get loading() {
                return o.loading;
            },

            get error() {
                return o.error;
            },

            get errorMessage() {
                return o.errorMessage;
            },

            getTitle: function () {
                return fixture.title;
            },

            getTargetEntityType: function () {
                return fixture.targetEntityType;
            },

            refresh: function () {
                log('refresh');
                fetched();
            },

            openDatasetItem: function (reference) {
                log('openDatasetItem', reference && reference.id);
            },

            getSelectedRecordIds: function () {
                /*
                 * A copy, because the platform's is not the control's to
                 * mutate. A control that pushes onto the array it was handed
                 * changes the host's selection without calling the setter, and
                 * on a real form that write is simply lost.
                 */
                return selected.slice();
            },

            setSelectedRecordIds: function (ids) {
                log('setSelectedRecordIds', ids.length);
                selected = (ids || []).slice();
            },

            clearSelectedRecordIds: function () {
                log('clearSelectedRecordIds');
                selected = [];
            },

            addColumn: function (name) {
                log('addColumn', name);

                /*
                 * Only a column the table actually has can arrive. `catalogue`
                 * on the fixture is the set of columns that exist but are not on
                 * the view — ask for anything else and nothing comes back,
                 * which is what a real table does with a name that is not one of
                 * its own. The control has to cope with having asked and not
                 * received.
                 */
                if (requestedColumns.indexOf(name) === -1) {
                    requestedColumns.push(name);
                }
            },
        };

        /*
         * Deleted rather than never defined, so the literal above stays one
         * readable shape.
         */
        if (!quirks.hasAddColumn) {
            delete dataset.addColumn;
        }

        /**
         * A round trip to the server: the requested page size takes effect and
         * a render is owed.
         *
         * Owed rather than performed, so that a control which refreshes from
         * inside `updateView` shows up as a count instead of a stack overflow.
         */
        function fetched() {
            /*
             * Columns asked for since the last fetch arrive now, if the table
             * has them. `fixture.catalogue` holds the columns that exist on the
             * table but are not on the bound view — which is the whole reason
             * `addColumn` exists.
             */
            var catalogue = fixture.catalogue || {};

            requestedColumns.forEach(function (name) {
                var definition = catalogue[name];
                var already = columns.some(function (column) {
                    return column.name === name;
                });

                if (definition && !already) {
                    columns.push(definition);
                }
            });

            requestedColumns = [];

            // Deletes the server has taken arrive with this fetch and not
            // before it. See the note on `removedPending`.
            removed = removed.concat(removedPending);
            removedPending = [];

            state.pageSize = state.requestedPageSize;
            filter = requestedFilter;
            state.refreshes += 1;
            state.renderOwed = true;
        }

        /**
         * `context.navigation`, assembled method by method.
         *
         * **Presence is per method, not per bag**, and that is the whole reason
         * this is a function rather than an object literal. `openForm` and
         * `openUrl` are there on every host; `openFile` is documented
         * model-driven only; the three dialogs are a model-driven affordance
         * that canvas does not have. A control that checks `context.navigation`
         * once and then calls four methods through it passes on the host it was
         * written on and throws on the next one — so each of these can be
         * removed independently here, because each is removed independently in
         * the world.
         *
         * Nothing is performed. Every call is recorded, so an assertion can be
         * about what the control *handed over* — which is the half that
         * regresses.
         */
        function buildNavigation() {
            if (!o.hasNavigation) {
                return undefined;
            }

            var navigation = {
                /**
                 * Resolves with an `OpenFormSuccessResponse`, whose
                 * `savedEntityReference` is populated only when a *quick create*
                 * form saved something — an ordinary form opening resolves with
                 * an empty array, and a control that waits for a reference from
                 * one waits forever.
                 */
                openForm: function (formOptions) {
                    log('navigation.openForm', {
                        entityName: (formOptions || {}).entityName,
                        entityId: (formOptions || {}).entityId,
                    });

                    return Promise.resolve({ savedEntityReference: [] });
                },

                /**
                 * **Returns `void`, not a promise.** The odd one out in this
                 * bag, and `void openUrl(...)` in the type definitions — so
                 * `await`ing it is harmless and `.catch()` on it is a
                 * TypeError. There is also no failure channel: a URL the host
                 * refuses to open reports nothing back, which is why the
                 * control has to decide the URL is acceptable *before* it calls.
                 */
                openUrl: function (url) {
                    log('navigation.openUrl', url);
                },
            };

            if (o.openFile) {
                navigation.openFile = function (file, fileOptions) {
                    log('navigation.openFile', {
                        fileName: (file || {}).fileName,
                        fileSize: (file || {}).fileSize,
                        mimeType: (file || {}).mimeType,
                        openMode: (fileOptions || {}).openMode,
                    });

                    return Promise.resolve();
                };
            }

            /*
             * 'absent' removes the three rather than making them fail, because
             * those are different states and only one of them is a bug in the
             * control.
             */
            if (o.dialogs === 'absent') {
                return navigation;
            }

            var refused = function () {
                return Promise.reject({
                    errorCode: 2147746581,
                    message: 'The dialog could not be opened.',
                });
            };

            navigation.openAlertDialog = function (alertStrings) {
                log('navigation.openAlertDialog', (alertStrings || {}).text);
                return o.dialogs === 'rejected' ? refused() : Promise.resolve();
            };

            /**
             * The one that matters, and the one everybody gets wrong.
             *
             * **Cancel is a resolve.** `{ confirmed: false }` comes back through
             * the success path, not through `catch` — so a control that puts
             * its delete inside `.then()` without reading `confirmed` deletes
             * the record the user just declined to delete, and a control that
             * treats the cancel as a failure shows an error for something the
             * user did on purpose. Both are one line away from correct and
             * neither shows up without this switch.
             */
            navigation.openConfirmDialog = function (confirmStrings) {
                log('navigation.openConfirmDialog', (confirmStrings || {}).text);

                return o.dialogs === 'rejected'
                    ? refused()
                    : Promise.resolve({ confirmed: o.dialogs === 'confirmed' });
            };

            navigation.openErrorDialog = function (errorOptions) {
                /*
                 * `details` is logged, and that is not tidiness.
                 *
                 * The control writes its own sentence into `message` and the
                 * *platform's* explanation into `details`, so an assertion that
                 * reads only `message` is reading a slot the platform never
                 * filled — it passes whether or not the rejection was ever
                 * decoded, which makes "and NOT [object Object]" a claim about
                 * nothing. Both halves are recorded so both can be asserted.
                 */
                log('navigation.openErrorDialog', {
                    message: (errorOptions || {}).message,
                    details: (errorOptions || {}).details,
                    errorCode: (errorOptions || {}).errorCode,
                });

                return o.dialogs === 'rejected' ? refused() : Promise.resolve();
            };

            return navigation;
        }

        function createContext() {
            var parameters = {
                records: dataset,
                /*
                 * **The control's `pageSize` input is not the host's page size,
                 * and this rig used to hand over one number for both.**
                 *
                 * `o.pageSize` is what the *platform* is paging at — what
                 * `paging.pageSize` reports, the way a main grid reports the
                 * user's *Rows per page*. The input below is what the *maker*
                 * typed into the property, and the point of that property
                 * carrying no `default-value` is that leaving it alone is a
                 * state the control can see. Seeding it from `o.pageSize` made
                 * that state unreachable: every mount looked like a maker who
                 * had deliberately asked for exactly what the host was already
                 * doing, so the adopt-the-host path was never once exercised.
                 */
                pageSize: {
                    raw: Object.hasOwn(o.inputs, 'pageSize') ? o.inputs.pageSize : null,
                    type: 'Whole.None',
                },
            };

            // The control's own inputs, wrapped the way the platform hands them
            // over. A raw `null` is a real value here — an input the maker left
            // unset — so it is passed through rather than defaulted.
            Object.keys(o.inputs).forEach(function (name) {
                parameters[name] = { raw: o.inputs[name], type: (parameters[name] || {}).type };
            });

            var context = {
                parameters: parameters,

                mode: {
                    isVisible: o.visible,
                    /*
                     * Hardcoded `false` until now, which meant no dataset
                     * control could be asserted against a read-only form at
                     * all — the state a maker produces by unchecking one box,
                     * and the one where a control that still lets you press
                     * things is a real bug rather than a cosmetic one.
                     *
                     * Distinct from `isVisible`: a hidden control renders
                     * nothing, a disabled one renders everything and acts on
                     * none of it.
                     */
                    isControlDisabled: o.disabled,
                    label: fixture.title,
                    // Recorded rather than delivered — "did the control ask for
                    // resize notifications" is a decision worth asserting; the
                    // resize itself comes from the `width` option.
                    trackContainerResize: function (value) {
                        log('trackContainerResize', value);
                    },
                    setFullScreen: function (value) {
                        log('setFullScreen', value);
                    },
                    allocatedWidth: o.width,
                    // Pinned at -1 under `heightUnmeasured`, whatever `height`
                    // says — a main grid answers the width and never this.
                    allocatedHeight: quirks.heightUnmeasured ? -1 : o.height,
                },

                /*
                 * The Web API, with its refusals modelled first.
                 *
                 * `retrieveRecord` answers from the fixture row rather than from
                 * a table of its own, so one place describes each row and the
                 * four outcomes are expressed by what that row carries:
                 *
                 *   body absent   -> resolves with the property MISSING, which
                 *                    is what a column nobody populated does
                 *   body ''       -> resolves with an empty string, which is a
                 *                    zero-byte file and not the same thing
                 *   body null     -> REJECTS
                 *   body '…'      -> resolves with it
                 *
                 * **The rejection is a plain object, not an `Error`, and that is
                 * the point of it.** `context.webAPI` rejects with an object
                 * carrying `errorCode` and `message`, exactly as the Client
                 * API's `errorCallback` documents — so a stub that rejected with
                 * an `Error` would pass a control that renders the string
                 * "[object Object]" where the platform's explanation belongs.
                 */
                webAPI: o.webAPI
                    ? {
                        retrieveRecord: function (entityType, id, options) {
                            log('webAPI.retrieveRecord', entityType + ' ' + id + ' ' + (options || ''));

                            var match = null;

                            (fixture.records || []).forEach(function (row) {
                                if (row.id === id) {
                                    match = row;
                                }
                            });

                            if (!match || match.body === null) {
                                return Promise.reject({
                                    errorCode: 2147746581,
                                    message: 'The record could not be retrieved.',
                                });
                            }

                            var selected = String(options || '').replace(/^\?\$select=/, '') || 'documentbody';
                            var answer = {};

                            if (match.body !== undefined) {
                                answer[selected] = match.body;
                            }

                            return Promise.resolve(answer);
                        },

                        /**
                         * The last `webAPI` method the catalogue had never
                         * called, and the only destructive one.
                         *
                         * Three things here are not obvious from the name:
                         *
                         * **It resolves with a `LookupValue`, not with
                         * nothing.** `Promise<LookupValue>` in the type
                         * definitions — `{ entityType, id, name }` for the
                         * record that is now gone. A control that awaits it
                         * expecting `void` is not wrong, but one that wants to
                         * name the deleted record in a message does not have to
                         * remember it first.
                         *
                         * **The row disappears from the fetch, not from the
                         * call.** `allRecords` is reassigned here, but the
                         * dataset does not re-read it until `fetched()` — so a
                         * control that deletes and forgets `dataset.refresh()`
                         * sees the row still on screen, which is exactly what a
                         * real form does. A stub that spliced the visible page
                         * would pass that control.
                         *
                         * **The rejection is a plain object.** See the note on
                         * `retrieveRecord` above; `webApiFails` is the switch.
                         */
                        deleteRecord: function (entityType, id) {
                            log('webAPI.deleteRecord', entityType + ' ' + id);

                            if (o.webApiFails) {
                                return Promise.reject({
                                    errorCode: 2147746581,
                                    message: 'The record could not be deleted.',
                                });
                            }

                            var gone = allRecords.filter(function (row) {
                                return row.id === id;
                            })[0];

                            if (removedPending.indexOf(id) === -1 && removed.indexOf(id) === -1) {
                                removedPending.push(id);
                            }

                            selected = selected.filter(function (chosen) {
                                return chosen !== id;
                            });

                            var primary = columns.filter(function (column) {
                                return column.isPrimary;
                            })[0];

                            return Promise.resolve({
                                entityType: entityType,
                                id: id,
                                name: gone && primary ? formatted(gone.values[primary.name]) : '',
                            });
                        },
                    }
                    : undefined,

                navigation: buildNavigation(),

                resources: {
                    getString:
                        o.getString
                        || function (key) {
                            return STRINGS[key] !== undefined ? STRINGS[key] : key;
                        },
                },

                // Absent on a host that publishes no theme — canvas, and the
                // hub's own demo harness.
                fluentDesignLanguage: hostKind.publishesTheme ? { isDarkTheme: Boolean(o.dark) } : undefined,

                userSettings: { isRTL: o.rtl, languageId: 1033 },

                client: {
                    getClient: function () {
                        return o.formFactor === 'phone' || o.formFactor === 'tablet' ? 'Mobile' : 'Web';
                    },
                    getFormFactor: function () {
                        return FORM_FACTORS[o.formFactor] !== undefined ? FORM_FACTORS[o.formFactor] : 1;
                    },
                    isOffline: function () {
                        return false;
                    },
                },

                updatedProperties: [],
            };

            /*
             * Deleted rather than never defined, so the literal above stays one
             * readable shape. A host that lacks full screen is a real host.
             */
            if (!quirks.hasFullScreen) {
                delete context.mode.setFullScreen;
            }

            return context;
        }

        return {
            dataset: dataset,
            context: createContext(),
            /** A fresh context object, as the platform hands down each pass. */
            nextContext: createContext,
            state: state,
            quirks: quirks,
            options: o,
            /** True while the control has asked for data it has not re-rendered against. */
            renderOwed: function () {
                return state.renderOwed;
            },
            settled: function () {
                state.renderOwed = false;
            },
        };
    }

    /**
     * Render until the control stops asking for more, and say how many passes
     * it took.
     *
     * This is the single most useful thing this file does. A dataset control's
     * mutators — `setPageSize`, `refresh`, `loadExactPage` — all end in a new
     * `updateView`, so an unguarded one is an infinite loop that a browser
     * shows as a hang and a rendered table shows as nothing at all. Here it is
     * a number: **a settled control renders twice** (once, then once more for
     * the page size it asked for), and anything that keeps climbing to the
     * limit is the loop.
     */
    function drive(instance, handle, limit) {
        var passes = 0;
        var max = limit || 10;
        var element;

        do {
            handle.settled();
            element = instance.updateView(handle.nextContext());
            passes += 1;
        } while (handle.renderOwed() && passes < max);

        /*
         * `element` is what a *virtual* control returned on the last pass, and
         * `undefined` for a standard one, which wrote into its container
         * instead. Handing it back is what lets one set of assertions read
         * either shape — a virtual dataset control's decisions are all in the
         * props it passed down.
         */
        return { passes: passes, looping: handle.renderOwed(), element: element };
    }

    function captureRegistration(global) {
        var box = { name: null, ctor: null };

        global.ComponentFramework = global.ComponentFramework || {};
        global.ComponentFramework.registerControl = function (fullName, ctor) {
            box.name = fullName;
            box.ctor = ctor;
        };

        return box;
    }

    return {
        ASCENDING: ASCENDING,
        DESCENDING: DESCENDING,
        AND: AND,
        OR: OR,
        OPERATOR: OPERATOR,
        FORM_FACTORS: FORM_FACTORS,
        HOSTS: HOSTS,
        STRINGS: STRINGS,
        DEFAULTS: DEFAULTS,
        createHost: createHost,
        drive: drive,
        captureRegistration: captureRegistration,
    };
});
