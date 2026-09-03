/*
 * The driver: wires the switches on `harness.html` to a real instance of the
 * control, and models the loop a dataset control actually lives in — mutate,
 * refresh, render again.
 *
 * Loaded before the control bundle, because the bundle registers itself the
 * moment it loads and needs somewhere to register. The page calls
 * `window.__harnessStart()` once the bundle has run.
 *
 * Read `harness.html` first — it says what this is for and what it is not.
 */

(function () {
    'use strict';

    var host = window.__pcfHost;
    var fixture = window.__pcfFixture;
    var registration = host.captureRegistration(window);

    var handle = null;
    var instance = null;
    var container = null;
    var lastInputs = {};

    /**
     * The input-property bag, as JSON.
     *
     * It is typed rather than picked from a list because the template cannot
     * know a control's own properties — and it exists at all because the rig
     * does not synthesise them: **a property with a manifest `default-value`
     * arrives here as `undefined` unless somebody puts it in this box.** A
     * control that reads `context.parameters.chartType.raw` therefore works on
     * a form and throws in the harness, which is a bug in the rig rather than a
     * reason to write a defensive `?.` in the control. Seed the manifest's own
     * defaults and the two hosts agree.
     *
     * Unparseable text keeps the last good bag rather than mounting against
     * `{}`, because a half-typed brace should not silently restyle the control.
     */
    function inputs() {
        var box = document.getElementById('harness-inputs');
        var parsed = null;

        try {
            parsed = JSON.parse(box.value || '{}');
        } catch (error) {
            parsed = null;
        }

        var usable = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);

        box.classList.toggle('is-bad', !usable);

        if (usable) {
            lastInputs = parsed;
        }

        return lastInputs;
    }

    function options() {
        var state = document.getElementById('harness-state').value;

        return {
            host: document.getElementById('harness-host').value,
            formFactor: document.getElementById('harness-formfactor').value,
            width: Number(document.getElementById('harness-width').value),
            pageSize: Number(document.getElementById('harness-pagesize').value) || 5,
            visible: document.getElementById('harness-visible').checked,
            disabled: document.getElementById('harness-disabled').checked,
            dark: document.getElementById('harness-dark').checked,
            rtl: document.getElementById('harness-rtl').checked,
            loading: state === 'loading',
            error: state === 'error',
            records: state === 'empty' ? [] : null,
            // "No columns chosen" is a real canvas state — the maker picked
            // none in the Items Fields flyout — and an empty table reads as a
            // broken control rather than as an unfinished configuration.
            columns: state === 'nocolumns' ? [] : null,
            inputs: inputs(),
            webAPI: document.getElementById('harness-webapi').checked,
            webApiFails: document.getElementById('harness-webapifails').checked,
            hasNavigation: document.getElementById('harness-navigation').checked,
            openFile: document.getElementById('harness-openfile').checked,
            dialogs: document.getElementById('harness-dialogs').value,
            quirks: {
                accumulatePages: document.getElementById('harness-accumulate').checked,
                previousPageStuck: document.getElementById('harness-stuck').checked,
                uncounted: document.getElementById('harness-uncounted').checked,
                hasLoadExactPage: document.getElementById('harness-exactpage').checked,
                sortingAbsent: document.getElementById('harness-nosorting').checked,
                filteringAbsent: document.getElementById('harness-nofiltering').checked,
                hasAddColumn: document.getElementById('harness-addcolumn').checked,
                hasFullScreen: document.getElementById('harness-fullscreen').checked,
            },
        };
    }

    /**
     * Build a fresh platform and mount a fresh control on it.
     *
     * A new instance per switch change, because `init` runs once per control on
     * a real form — reusing one across a page-size change would be testing a
     * sequence the platform never produces. Paging and sorting *within* a
     * configuration are driven through the live instance, which is where the
     * sequence does matter.
     */
    function mount() {
        if (instance && instance.destroy) {
            instance.destroy();
        }

        handle = host.createHost(fixture, options());
        container = document.getElementById('harness-root');
        container.innerHTML = '';

        instance = new registration.ctor();
        instance.init(handle.context, function () {}, {}, container);

        pump();
    }

    /**
     * Render until the control stops asking for more.
     *
     * `drive` reports how many passes that took, and the number is the
     * assertion: a settled control renders twice — once, then once more for the
     * page size it asked for — and one that keeps climbing has an unguarded
     * mutator in `updateView`. That is an infinite loop on a real form, where
     * it looks like a hang rather than like a count.
     */
    function pump() {
        var driven = host.drive(instance, handle, 10);
        var badge = document.getElementById('harness-passes');

        badge.textContent = driven.looping
            ? 'still refreshing after ' + driven.passes + ' passes — unguarded mutator'
            : driven.passes + ' render pass' + (driven.passes === 1 ? '' : 'es');
        badge.classList.toggle('is-bad', driven.looping);

        var surface = document.getElementById('harness-surface');
        surface.classList.toggle('is-dark', document.getElementById('harness-dark').checked);
        surface.dir = document.getElementById('harness-rtl').checked ? 'rtl' : 'ltr';

        document.getElementById('harness-calls').textContent =
            handle.state.calls.length > 0
                ? handle.state.calls
                    .map(function (call, index) {
                        return String(index + 1).padStart(3, ' ') + '  ' + call;
                    })
                    .join('\n')
                : 'Nothing yet. Sort a column or turn a page.';
    }

    window.__harnessStart = function () {
        var status = document.getElementById('harness-status');

        if (typeof registration.ctor !== 'function') {
            status.textContent = 'No control registered — run npm run build, then reload.';

            return;
        }

        /*
         * One listener on the panel rather than one per switch.
         *
         * `change` bubbles, so every control inside — including ones added
         * later — is wired by existing. The list this replaces had to be edited
         * in two places to add a switch, and a switch added to the markup and
         * forgotten here did nothing at all while looking entirely functional,
         * which is the worst way for a rig to fail.
         */
        document.querySelector('.harness-controls').addEventListener('change', mount);

        /*
         * The inputs box is the one control that is not a switch: it is typed
         * into, and waiting for blur to remount makes it feel broken.
         */
        document.getElementById('harness-inputs').addEventListener('input', mount);

        /*
         * The platform's asynchronous re-render, in one line.
         *
         * The control's own click handlers run first — this listener is on the
         * container, so it fires as the event bubbles past — and the deferral
         * puts the re-render on a later turn, which is where the platform puts
         * it. Rendering synchronously from inside the control's handler would
         * re-enter it mid-update, a shape the platform never produces, so a bug
         * found that way would not be a real one.
         */
        document.getElementById('harness-root').addEventListener('click', function () {
            window.setTimeout(pump, 0);
        });

        /*
         * And the case a click listener alone misses.
         *
         * A control can ask the platform for data from something other than a
         * click — a debounce around a search box, an auto-refresh, any timer.
         * Without this the request is made, the stand-in serves it, and
         * nothing ever renders the answer: the control looks like it ignored
         * what was typed, which is the exact bug the rig exists to rule out.
         *
         * Polling rather than hooking refresh() keeps the stand-in honest.
         * It renders when the platform owes a render and at no other time, so
         * the pass count still means what it means.
         */
        window.setInterval(function () {
            if (handle && handle.renderOwed()) {
                pump();
            }
        }, 50);

        status.textContent = 'Registered ' + registration.name + '.';

        mount();
    };
})();
