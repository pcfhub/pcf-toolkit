import { IInputs, IOutputs } from './generated/ManifestTypes';
import { friendly, isFollowable } from '../../shared/url';

type DataSet = ComponentFramework.PropertyTypes.DataSet;
type Column = ComponentFramework.PropertyHelper.DataSetApi.Column;
type SortDirection = ComponentFramework.PropertyHelper.DataSetApi.Types.SortDirection;

/** `SortDirection` is a numeric union, not an enum object — there is nothing to import. */
const ASCENDING = 0 as SortDirection;
const DESCENDING = 1 as SortDirection;

/** The platform's ceiling on a page. Not in the type definitions. */
const MAX_PAGE_SIZE = 250;

/**
 * A standard (DOM) dataset control.
 *
 * **What `--type dataset` scaffolds is a table**, with sortable headers, a pager
 * and an open-record button. That is the right default and its comments are the
 * traps a dataset control hits — but a dataset control that is *not* a table
 * replaces most of this file rather than adjusting it. A board, a calendar or a
 * chart keeps the paging and mutator discipline below and little else. Knowing
 * that now is cheaper than discovering it after the manifest is written.
 *
 * A dataset control binds a collection — a view, a subgrid, a canvas table —
 * rather than a single column, and the difference is not just the shape of the
 * data. **A dataset has mutators**, and that changes what `updateView` means.
 *
 * `updateView` runs on every change to any bound value, including the ones this
 * control caused itself. For a field control that shows up as a jumping caret.
 * Here it is an infinite loop: `setPageSize()` does nothing until the next
 * fetch, so it has to be followed by `refresh()` — and `refresh()` fires
 * `updateView`. Every mutator call below is either guarded or in an event
 * handler, and that is the single most important thing to preserve when you
 * edit this file.
 *
 * The second thing to preserve is smaller and easier to lose: this control
 * rebuilds its whole DOM on every render, so **anything the user was focused on
 * ceases to exist**. That is fine for the records, which change wholesale
 * anyway, and wrong for the buttons in the chrome — clicking Next destroys the
 * Next button mid-interaction. `restoreFocus` below is how that is paid for,
 * and any control you add with a persistent action needs the same.
 *
 * The third is why the pager reads none of `hasPreviousPage`, `firstPageNumber`
 * or the raw length of `sortedRecordIds`. Observed on a real model-driven form:
 * `loadNextPage(true)` ignores its argument and returns the whole page range,
 * `hasPreviousPage` stays false so Previous never unlocks, and `firstPageNumber`
 * disagrees with the ids badly enough to print a range past its own total. The
 * page number is this control's own counter, and `currentPage()` cuts the
 * accumulated array back down. Both are commented where they are.
 */
export class LinkColumn implements ComponentFramework.StandardControl<IInputs, IOutputs> {
    private container!: HTMLDivElement;
    private notifyOutputChanged!: () => void;
    private openedRecordId = '';

    /**
     * The page size this control has already asked the platform for.
     *
     * Guarding on this rather than on `ds.paging.pageSize` is the whole trick:
     * the platform's own value will not equal the requested one until the
     * refresh lands, so comparing against it re-fires at least once more — and
     * if the platform clamps the request, it never converges at all.
     */
    private appliedPageSize = 0;

    private page = 1;

    /**
     * Which chrome button to put focus back on after the next render.
     *
     * Set in a click handler, consumed once at the end of `render()`. Paging
     * with the keyboard is otherwise a one-shot: the button is destroyed by the
     * render its own click caused, focus falls back to `<body>`, and turning a
     * second page means tabbing in from the top of the form again.
     */
    private restoreFocus: 'previous' | 'next' | null = null;

    /**
     * The most recent context, for the cell handlers, which are handed none.
     *
     * Refreshed on every `updateView` rather than captured once in `init`: the
     * context object is not guaranteed to be the same instance twice, and a
     * stale one reports a host state the form has already left.
     */
    private context?: ComponentFramework.Context<IInputs>;

    public init(
        _context: ComponentFramework.Context<IInputs>,
        notifyOutputChanged: () => void,
        _state: ComponentFramework.Dictionary,
        container: HTMLDivElement,
    ): void {
        this.notifyOutputChanged = notifyOutputChanged;
        this.container = container;
        this.container.classList.add('LinkColumn');
    }

    public updateView(context: ComponentFramework.Context<IInputs>): void {
        this.context = context;

        const dataset = context.parameters.records;

        this.applyTheme(context);
        this.applyPageSize(context, dataset);
        this.render(context, dataset);
    }

    /**
     * Picks which set of colour fallbacks the stylesheet uses.
     *
     * Only the fallbacks. The stylesheet reads Fluent's design tokens through
     * `var()`, and a model-driven form already mounts a `FluentProvider` above
     * every code component on the page — so where the host publishes them this
     * changes nothing at all, which is what stops the control fighting a host
     * that knows its own theme better than this code does. It matters on the
     * hosts that publish nothing: a canvas app, or PCFHub's demo harness.
     *
     * The React variant of this control needs no equivalent. It mounts its own
     * `FluentProvider` with the host's `tokenTheme`, so every token resolves
     * and no fallback is ever reached.
     *
     * `@media (prefers-color-scheme: dark)` is the obvious hook and it is the
     * wrong question: a model-driven app carries its own theme and the user's
     * OS setting says nothing about it, so an OS-dark machine on a light app
     * would render a dark table on a white form. Absent means absent — no
     * class, light fallbacks, the same guess the host made by not saying.
     */
    private applyTheme(context: ComponentFramework.Context<IInputs>): void {
        const isDarkTheme = context.fluentDesignLanguage?.isDarkTheme;

        if (isDarkTheme === undefined) {
            return;
        }

        this.container.classList.toggle('LinkColumn--dark', isDarkTheme);
    }

    /**
     * `null` is not `undefined` here: the generated `IOutputs` types every
     * output as optional, and `undefined` means "no change" — so a cleared
     * value would be unobservable. Emit the empty string instead.
     */
    public getOutputs(): IOutputs {
        return { openedRecordId: this.openedRecordId };
    }

    public destroy(): void {
        // Listeners are attached to elements inside `container`, which the
        // platform removes — but the container itself is reused, so clear it.
        this.container.innerHTML = '';
    }

    /**
     * Ask for a new page size, but only when it actually changed. See the note
     * above.
     *
     * If you add a **second** guarded mutator to `updateView` — a paging mode, a
     * filter, anything that ends in `refresh()` — make it skip its own first
     * run. On the very first `updateView` every "applied" field still holds its
     * initial value, so every guard fires at once and each one refreshes: one
     * load, several round trips. Guarding on `applied === ''` (or a `-1`
     * sentinel) rather than on a real default is what distinguishes "nobody has
     * asked yet" from "the answer changed".
     */
    private applyPageSize(context: ComponentFramework.Context<IInputs>, dataset: DataSet): void {
        const raw = context.parameters.pageSize.raw;

        /*
         * **The platform already has a page size, and it is usually the right
         * one.** `paging.pageSize` is the size the host is actually retrieving
         * with — a main grid's *Rows per page* personalisation, a subgrid's
         * form-designer setting, the canvas default.
         *
         * So the property carries no `default-value`, and this is the half of
         * that decision written in code: unset, adopt what the host is doing and
         * **never call `setPageSize` at all**; set, override. Adopting still
         * records the number, because the page slice and the pager label both
         * need to know how big a page is — reading it is not the same as asking
         * for it. See the manifest for why the default was removed.
         */
        if (raw === null || raw === undefined) {
            // `0` is "the host did not say", not "one row per page". A fallback
            // of `1` is a page size the platform never has, and the slice would
            // cut the view down to it — twenty rows arriving and one drawn.
            this.appliedPageSize = dataset.paging.pageSize > 0 ? dataset.paging.pageSize : 0;

            return;
        }

        const wanted = Math.min(Math.max(Math.trunc(raw), 1), MAX_PAGE_SIZE);

        if (wanted === this.appliedPageSize) {
            return;
        }

        const previous = this.appliedPageSize;

        this.appliedPageSize = wanted;
        dataset.paging.setPageSize(wanted);

        /*
         * **Repaginating makes "page 4" mean something else**, so the reader
         * goes back to the first page — the same move `sortBy` makes, and for
         * the same reason. Any change to the shape of the result set — a sort,
         * a filter, a page size — resets the page.
         *
         * **Only when it changed, though.** `previous` is 0 until a size has
         * been applied, and at mount the platform is already on page one, so
         * resetting there is a round trip bought for nothing: `reset()` is a
         * fetch in its own right and the `refresh()` below is a second one.
         *
         * Left out entirely at first, and close to unfalsifiable while the size
         * comes only from a manifest property: a property changes once, at
         * configuration time, almost always while the reader is on page one.
         * `pcf-data-table` 0.2.0 made it reachable with a rows-per-page picker,
         * and asked for page 3 of a result set that had just been recut.
         */
        if (previous > 0) {
            this.page = 1;
            dataset.paging.reset();
        }

        dataset.refresh();
    }

    private render(context: ComponentFramework.Context<IInputs>, dataset: DataSet): void {
        const getString = (id: string): string => context.resources.getString(id);

        this.container.innerHTML = '';

        // Canvas relies on this; a model-driven form hides the section itself.
        if (!context.mode.isVisible) {
            return;
        }

        if (dataset.error) {
            this.message(dataset.errorMessage || getString('LinkColumn_Error'));
            return;
        }

        // `isHidden` and `order` are the maker's decisions in the view
        // designer. A table that ignores either looks broken to whoever set
        // them.
        const columns = (dataset.columns ?? [])
            .filter((column) => !column.isHidden)
            .sort((a, b) => a.order - b.order);

        // A canvas app supplies only the columns picked in the Items Fields
        // flyout. None picked is a real state, and an empty <table> reads as a
        // broken control rather than as an unfinished configuration.
        if (columns.length === 0) {
            this.message(
                dataset.loading ? getString('LinkColumn_Loading') : getString('LinkColumn_NoColumns'),
            );
            return;
        }

        // `loading` is true on the first updateView, before any records arrive,
        // so rendering the empty state here flashes "No records" on every load.
        const all = dataset.sortedRecordIds ?? [];

        if (all.length === 0) {
            this.message(dataset.loading ? getString('LinkColumn_Loading') : getString('LinkColumn_Empty'));
            return;
        }

        const ids = this.currentPage(all);

        this.container.appendChild(this.table(dataset, columns, ids, getString));
        this.container.appendChild(this.pager(dataset, ids.length, getString));

        // The button that caused this render no longer exists. Put focus on its
        // replacement, or fall back to the other one when this page turn was
        // the last: a disabled button cannot take focus, and silently doing
        // nothing here would strand the keyboard at <body>.
        if (this.restoreFocus) {
            const wanted = this.restoreFocus;
            this.restoreFocus = null;

            const button =
                this.container.querySelector<HTMLButtonElement>(`.LinkColumn-${wanted}`);
            const other = this.container.querySelector<HTMLButtonElement>(
                `.LinkColumn-${wanted === 'next' ? 'previous' : 'next'}`,
            );

            (button?.disabled ? other : button)?.focus();
        }
    }

    /**
     * The records belonging to the page the pager says it is on.
     *
     * **This is the one place a dataset control should slice
     * `sortedRecordIds`, and the usual rule is never to do it.** On a platform
     * that honours `loadOnlyNewPage`, that array already *is* the current page,
     * and slicing hides records the platform paged for. A single-page demo
     * fixture tempts you into it and the temptation is wrong.
     *
     * Except that the flag is not honoured. Observed on a real model-driven
     * form: `loadNextPage(true)` from page 1 of a 6-record view at page size 3
     * returned all six ids, and page 2 rendered under page 1. The argument is
     * documented, typed, passed and ignored.
     *
     * So the slice is a repair for one specific platform behaviour, written to
     * disappear the moment that behaviour changes: when the array is no longer
     * than a page it already is the page, and nothing is cut. Slicing by page
     * offset rather than taking the tail is what makes it right going backwards
     * as well as forwards.
     *
     * A control that *wants* the accumulation — a "load more" list, where the
     * point is that earlier records stay on screen — should not call this.
     */
    private currentPage(ids: string[]): string[] {
        // `0` is "the host reported no page size" — see `applyPageSize`.
        // There is no page to cut to, so draw everything that arrived.
        if (this.appliedPageSize <= 0 || ids.length <= this.appliedPageSize) {
            return ids;
        }

        const start = (this.page - 1) * this.appliedPageSize;
        const slice = ids.slice(start, start + this.appliedPageSize);

        // Never empty the table: showing the wrong page is recoverable by
        // clicking, showing nothing looks like data loss.
        return slice.length > 0 ? slice : ids.slice(-this.appliedPageSize);
    }

    private message(text: string): void {
        const p = document.createElement('p');
        p.className = 'LinkColumn-message';
        p.textContent = text;
        this.container.appendChild(p);
    }

    private table(
        dataset: DataSet,
        columns: Column[],
        ids: string[],
        getString: (id: string) => string,
    ): HTMLElement {
        const table = document.createElement('table');
        table.className = 'LinkColumn-table';

        const caption = document.createElement('caption');
        caption.className = 'LinkColumn-caption';
        caption.textContent = dataset.getTitle();
        table.appendChild(caption);

        const head = table.createTHead().insertRow();

        for (const column of columns) {
            const th = document.createElement('th');
            th.scope = 'col';

            // The fixture format cannot express a non-sortable column, so
            // `undefined` means sortable — which is what a view reports for an
            // ordinary column too.
            if (column.disableSorting) {
                th.textContent = column.displayName;
            } else {
                // `sorting` is typed as a required array, and the local test
                // harness supplies `undefined` for it — so this reads through
                // a fallback. Without it, `npm start` renders a blank control
                // and swallows the TypeError, which is the worst possible
                // first impression of a freshly scaffolded dataset control.
                const status = (dataset.sorting ?? []).find((entry) => entry.name === column.name);
                th.setAttribute(
                    'aria-sort',
                    status ? (status.sortDirection === DESCENDING ? 'descending' : 'ascending') : 'none',
                );

                // A real <button>, so sorting is reachable by keyboard. A click
                // handler on the <th> is not.
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'LinkColumn-sort';
                button.textContent = column.displayName;
                button.title = getString('LinkColumn_SortBy').replace('{0}', column.displayName);
                button.addEventListener('click', () => this.sortBy(dataset, column.name));
                th.appendChild(button);
            }

            head.appendChild(th);
        }

        const body = table.createTBody();
        const primary = columns.find((column) => column.isPrimary) ?? columns[0];

        for (const id of ids) {
            const record = dataset.records[id];

            if (!record) {
                continue;
            }

            const row = body.insertRow();

            for (const column of columns) {
                const cell = row.insertCell();

                if (column.name === primary.name) {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'LinkColumn-open';
                    button.textContent = record.getFormattedValue(column.name);
                    button.title = getString('LinkColumn_OpenRecord').replace(
                        '{0}',
                        record.getFormattedValue(primary.name),
                    );
                    button.addEventListener('click', () => this.openRecord(dataset, id));
                    cell.appendChild(button);
                } else {
                    // `getFormattedValue` takes the column's *name*. With
                    // property-set roles the column is found by `alias` and read
                    // by `name`, and getting that backwards renders zero rows
                    // against real data while looking fine in a demo fixture.
                    const text = record.getFormattedValue(column.name);

                    /*
                     * The half of this repository that makes it a toolkit rather
                     * than two unrelated controls: a cell holding a web address
                     * becomes a link, under exactly the rule `LinkField` uses on
                     * a form. `shared/url.ts` is imported by both so the two
                     * cannot drift on it — the allow-list is a security boundary,
                     * and a boundary enforced in two places is a boundary
                     * enforced in the weaker of them.
                     *
                     * **The raw value, not the formatted one.** `getFormattedValue`
                     * is what the platform would print, and for a URL column that
                     * is usually the same string — but "usually" is not a rule to
                     * build an allow-list on, so the decision to open is taken on
                     * `getValue` and only the *label* comes from the formatter.
                     */
                    const raw = record.getValue(column.name);

                    if (isFollowable(raw)) {
                        const link = document.createElement('a');

                        link.className = 'LinkColumn-link';
                        link.href = raw;

                        /*
                         * The site name, not the formatted value — the same
                         * choice `LinkField` makes, and the reason these two
                         * ship together. `getFormattedValue` on a URL column
                         * returns the address itself, so honouring it here would
                         * make a row of links that are mostly query string while
                         * the same value on a form read `contoso.example.com`.
                         *
                         * A toolkit whose two halves disagree about what a link
                         * looks like is two controls in a trench coat.
                         */
                        link.textContent = friendly(raw);
                        link.title = getString('LinkColumn_OpenLink').replace('{0}', friendly(raw));

                        /*
                         * Prevented and routed through the platform, for the
                         * reason `LinkField` gives at length: an unprevented
                         * click inside a model-driven grid navigates the form's
                         * own iframe, and inside canvas leaves the app.
                         */
                        link.addEventListener('click', (event) => {
                            event.preventDefault();
                            this.follow(raw);
                        });

                        cell.appendChild(link);
                    } else {
                        cell.textContent = text;
                    }
                }
            }
        }

        const scroll = document.createElement('div');
        scroll.className = dataset.loading ? 'LinkColumn-scroll is-loading' : 'LinkColumn-scroll';
        scroll.appendChild(table);

        return scroll;
    }

    private pager(dataset: DataSet, rowsOnPage: number, getString: (id: string) => string): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'LinkColumn-pager';

        /*
         * `hasPreviousPage` answers a different question than it appears to.
         *
         * Observed on a real model-driven form: after paging forward it stays
         * false, so Previous never unlocks and there is no way back. The
         * platform treats the load as the *range* pages 1..N, and a range
         * beginning at page 1 truthfully has nothing before it.
         *
         * The control's own counter is what answers "is there a page before
         * this one", so that is what drives the button.
         */
        const previous = document.createElement('button');
        previous.type = 'button';
        previous.className = 'LinkColumn-previous';
        // Chevron then label. Decoration on a button that already says what it
        // does, so the accessible name is unchanged.
        previous.append(chevron(CHEVRON_PREVIOUS), document.createTextNode(getString('LinkColumn_Previous')));
        previous.disabled = this.page <= 1;
        previous.addEventListener('click', () => {
            if (this.page <= 1) {
                return;
            }

            this.restoreFocus = 'previous';
            this.goToPage(dataset, this.page - 1);
        });

        const status = document.createElement('span');
        status.className = 'LinkColumn-pagerStatus';
        status.setAttribute('aria-live', 'polite');
        status.textContent = this.pagerLabel(dataset, rowsOnPage, getString);

        // `hasNextPage` has behaved, and it is the only available answer to
        // "is there more" — a local counter cannot supply that one.
        const next = document.createElement('button');
        next.type = 'button';
        next.className = 'LinkColumn-next';
        // Label then chevron: the glyph points the way the button goes.
        next.append(document.createTextNode(getString('LinkColumn_Next')), chevron(CHEVRON_NEXT));
        next.disabled = !dataset.paging.hasNextPage;
        next.addEventListener('click', () => {
            if (!dataset.paging.hasNextPage) {
                return;
            }

            this.restoreFocus = 'next';
            this.goToPage(dataset, this.page + 1);
        });

        wrap.append(previous, status, next);

        return wrap;
    }

    /**
     * Turn to an absolute page.
     *
     * `loadExactPage` says what a pager means, and it is the documented
     * fallback for a host that ignores `loadOnlyNewPage` — which real ones do.
     * It is typed as required and feature-detected anyway: a required member is
     * a claim about the type definitions, not about the host, and this method
     * exists because one of those claims did not hold.
     */
    private goToPage(dataset: DataSet, target: number): void {
        const back = target < this.page;

        this.page = Math.max(1, target);

        if (typeof dataset.paging.loadExactPage === 'function') {
            dataset.paging.loadExactPage(this.page);
            return;
        }

        if (back) {
            dataset.paging.loadPreviousPage(true);
        } else {
            dataset.paging.loadNextPage(true);
        }
    }

    /**
     * `totalResultCount` is -1 when the platform did not count the rows, which
     * is common on large views. Printing "of -1" is the tell that nobody
     * checked, so name the page instead of the range.
     *
     * The page number is this control's own counter. `firstPageNumber` was
     * preferred here once and produced **"4–9 of 6"** on a real form: it
     * reported 2 while `sortedRecordIds` held both pages, so a start taken from
     * the platform met a row count taken from an accumulated array. Two sources
     * in one sentence is what let the range run past its own total.
     */
    private pagerLabel(dataset: DataSet, rowsOnPage: number, getString: (id: string) => string): string {
        const total = dataset.paging.totalResultCount;

        if (total < 0) {
            return getString('LinkColumn_PageStatus').replace('{0}', String(this.page));
        }

        const start = (this.page - 1) * this.appliedPageSize + 1;

        return getString('LinkColumn_RangeStatus')
            .replace('{0}', String(Math.min(start, total)))
            .replace('{1}', String(Math.min(start + rowsOnPage - 1, total)))
            .replace('{2}', String(total));
    }

    /**
     * Sorting is server-side, applied across every page.
     *
     * That is the reason not to sort in the browser: a client-side sort
     * reorders the rows on screen — 25 out of 240 — which is a wrong answer
     * that looks completely right.
     *
     * `dataset.sorting` is an array you mutate in place, and it is the whole
     * ORDER BY. Replacing rather than appending is what stops three clicks
     * building a three-deep sort nobody asked for.
     */
    private sortBy(dataset: DataSet, columnName: string): void {
        const sorting = dataset.sorting;

        /*
         * Typed as required, absent on `npm start`.
         *
         * The order has to be expressed by mutating this array in place, so
         * with no array there is nothing to express it through — and the local
         * harness cannot sort anyway. Decline rather than throw: a click that
         * does nothing there is a great deal better than a control that
         * disappears.
         */
        if (!sorting) {
            return;
        }

        const current = sorting.find((status) => status.name === columnName);
        const direction: SortDirection = current?.sortDirection === ASCENDING ? DESCENDING : ASCENDING;

        sorting.length = 0;
        sorting.push({ name: columnName, sortDirection: direction });

        // A new order makes "page 4" meaningless.
        this.page = 1;
        dataset.paging.reset();
        dataset.refresh();
    }

    /**
     * Notify before opening, so the output is observable even on a host where
     * `openDatasetItem` does nothing — which is the canvas case.
     *
     * It takes an EntityReference, and `getNamedReference()` is the only way to
     * build one; there is no id-based overload.
     */
    /**
     * Open a link from a cell, through the platform.
     *
     * Feature-detected like every other `navigation` member: the bag is present
     * on every host and typed non-optional, so this compiles whether or not the
     * host implements the method. `openUrl` returns `void` — no promise, no
     * error — so everything checkable is checked before the call, not after.
     */
    private follow(url: string): void {
        const navigation = this.context?.navigation;

        if (navigation && typeof navigation.openUrl === 'function') {
            navigation.openUrl(url);
        }
    }

    private openRecord(dataset: DataSet, id: string): void {
        const record = dataset.records[id];

        if (!record) {
            return;
        }

        this.openedRecordId = id;
        this.notifyOutputChanged();
        dataset.openDatasetItem(record.getNamedReference());
    }
}

/** The SVG namespace. `createElement('svg')` makes an *HTML* element of that
 *  name: it parses, it appends, it occupies no space and draws nothing. */
const SVG_NS = 'http://www.w3.org/2000/svg';

/** The pager chevrons, on a 20×20 grid. Two strokes each. */
const CHEVRON_PREVIOUS = 'M12.5 5 7.5 10l5 5';
const CHEVRON_NEXT = 'M7.5 5l5 5-5 5';

/**
 * A chevron, inline, so it can follow the theme.
 *
 * **An `<img>` cannot do this job**, whatever the file format. An image behind
 * `<img src>` — a resource, a data URL, PNG or SVG alike — renders as an
 * isolated document that cannot see this control's stylesheet, so a
 * `currentColor` inside it resolves to black and a dark form gets a black glyph
 * on a dark background. A control in this house shipped exactly that, and it
 * was found on a real form rather than in review. Inline, `currentColor` is
 * whatever the button's `color` resolves to.
 *
 * Three things bite while writing one:
 *
 *   - `createElement('svg')` makes an HTML element named “svg” that draws
 *     nothing, and the failure reads as a CSS problem. `createElementNS` is not
 *     optional.
 *   - `className` on an SVG element is a read-only `SVGAnimatedString`;
 *     assigning to it silently does nothing. Use `classList`.
 *   - `hidden` is an `HTMLElement` property, so hiding one needs the
 *     *attribute* and a `[hidden]` rule to outrank the element's own display.
 *
 * Decorative, because it sits on a button that already says what it does.
 */
function chevron(d: string): SVGSVGElement {
    const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;

    svg.classList.add('LinkColumn-chevron');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    const path = document.createElementNS(SVG_NS, 'path');

    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');

    svg.appendChild(path);

    return svg;
}
