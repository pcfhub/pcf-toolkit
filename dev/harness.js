/*
 * The driver: wires the switches on `harness.html` to a real instance of the
 * control, and models the one part of the platform that surprises people —
 * the round trip.
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
    var registration = host.captureRegistration(window);

    /** The platform's copy of the column, which is not the control's copy. */
    var columnValue = host.DEFAULTS.value;

    var instance = null;
    var container = null;
    var notifications = 0;

    /** Every `trackContainerResize` / `setFullScreen` call the control made. */
    var calls = [];

    /*
     * What the "Location" switch means, spelled out here rather than in the
     * markup so the page stays a list of switches and this stays a list of
     * platform behaviours.
     *
     * The two fixes differ only in `accuracy`, which is the number a control
     * has to make a decision about: a 1200-metre fix is a real answer from a
     * real device on a bad day, not an error, and a control that renders it the
     * same way it renders a 20-metre one is lying to whoever reads the record.
     */
    var POSITIONS = {
        seattle: { latitude: 47.6062, longitude: -122.3321, accuracy: 20 },
        vague: { latitude: 47.6062, longitude: -122.3321, accuracy: 1200 },
    };

    /*
     * One `FileObject`, and `fileSize` in **KB** — see `pickFile` in
     * `host.js`. A one-pixel PNG, so the content is real base64 rather than a
     * word that happens to be in the right field.
     */
    var PHOTO = {
        fileName: 'capture.png',
        mimeType: 'image/png',
        fileSize: 1,
        fileContent:
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    };

    function options() {
        return {
            host: document.getElementById('harness-host').value,
            formFactor: document.getElementById('harness-formfactor').value,
            width: Number(document.getElementById('harness-width').value),
            calls: calls,
            value: columnValue,
            security: document.getElementById('harness-security').value,
            error: document.getElementById('harness-error').checked,
            disabled: document.getElementById('harness-disabled').checked,
            visible: document.getElementById('harness-visible').checked,
            dark: document.getElementById('harness-dark').checked,
            rtl: document.getElementById('harness-rtl').checked,
            position:
                POSITIONS[document.getElementById('harness-position').value]
                || document.getElementById('harness-position').value,
            captureImage: document.getElementById('harness-camera').value === 'photo' ? PHOTO : null,
            contextInfo:
                document.getElementById('harness-identity').value === 'contextinfo'
                    ? { entityId: '0f8fad5b-d9cb-469f-a165-70867728950e', entityTypeName: 'account' }
                    : null,
            webAPI: document.getElementById('harness-webapi').checked,
            utils: document.getElementById('harness-utils').checked,
            offline: document.getElementById('harness-offline').checked,
        };
    }

    /*
     * What the platform does after a control says its outputs changed.
     *
     * It reads `getOutputs()`, keeps the answer as the column's new value, and
     * comes back through `updateView` with it. Modelling that round trip is
     * most of the value of this page: it is the loop in which a control that
     * assigns `input.value` unconditionally moves the caret to the end on every
     * keystroke, and the loop in which a control that re-adopts the platform's
     * value without comparing it discards the edit that caused the call.
     *
     * Deferred rather than immediate, because the platform is asynchronous and
     * because calling back synchronously from inside the control's own event
     * handler would re-enter it mid-update — a shape the platform never
     * produces, so a bug found that way would not be a real one.
     *
     * **`undefined` means "no change".** A control that returns `undefined` for
     * a value the user cleared leaves the column holding the old value, which
     * is why the assignment below is guarded on the key being present rather
     * than on the value being truthy. Canvas honours this strictly; a
     * model-driven form is more forgiving, which is how the bug reaches
     * production having been "tested".
     */
    function notifyOutputChanged() {
        notifications += 1;

        window.setTimeout(function () {
            var outputs = instance.getOutputs ? instance.getOutputs() : {};

            if (Object.prototype.hasOwnProperty.call(outputs, 'value') && outputs.value !== undefined) {
                columnValue = outputs.value;
                document.getElementById('harness-value').value = outputs.value === null ? '' : String(outputs.value);
            }

            render();
        }, 0);
    }

    function render() {
        var context = host.createContext(options());

        instance.updateView(context);

        var form = document.getElementById('harness-form');
        form.classList.toggle('is-dark', document.getElementById('harness-dark').checked);
        form.dir = context.userSettings.isRTL ? 'rtl' : 'ltr';

        document.getElementById('harness-formlabel').textContent = context.mode.label;

        showOutputs();
    }

    /*
     * `getOutputs()` printed as it actually is, with `undefined` visible.
     *
     * `JSON.stringify` drops undefined values entirely, which hides the single
     * most consequential mistake a field control makes — so each key is
     * formatted by hand and the absence is spelled out.
     */
    function showOutputs() {
        var outputs = instance.getOutputs ? instance.getOutputs() : {};
        var lines = Object.keys(outputs).map(function (key) {
            var value = outputs[key];
            var shown;

            if (value === undefined) {
                shown = 'undefined   <- the platform reads this as "no change"';
            } else if (value === null) {
                shown = 'null        <- an explicit clear';
            } else {
                shown = JSON.stringify(value);
            }

            return '  ' + key + ': ' + shown;
        });

        document.getElementById('harness-outputs').textContent =
            lines.length > 0 ? '{\n' + lines.join('\n') + '\n}' : '{}';

        /*
         * Whether the control asked for resize notifications, which decides
         * whether `allocatedWidth` is ever anything but -1. A control that
         * reads the width without asking lays out against -1 on every host,
         * and nothing else on this page would show that.
         */
        document.getElementById('harness-notified').textContent =
            'notifyOutputChanged x' + notifications
            // Only the resize calls, which arrive as a bare boolean.
            // `calls` also collects `getResource(…)` and `pickFile(…)` entries,
            // and counting those would report every control as having asked.
            + (calls.some(function (call) { return call.indexOf('trackContainerResize') === 0; })
                ? ' · trackContainerResize called'
                : ' · never asked to be resized');
    }

    window.__harnessStart = function () {
        var status = document.getElementById('harness-status');

        if (typeof registration.ctor !== 'function') {
            status.textContent = 'No control registered — run npm run build, then reload.';

            return;
        }

        var context = host.createContext(options());

        container = document.getElementById('harness-root');
        instance = new registration.ctor();

        /*
         * A virtual (React) control returns an element from `updateView` and is
         * never handed a container, so it cannot be driven from a page that has
         * no React on it. `--framework react` removes this file for that
         * reason; if you are reading this inside a React control, the harness
         * was reinstated by hand and needs React and Fluent on the page before
         * it can work. `npm run smoke` covers that shape without a browser.
         */
        instance.init(context, notifyOutputChanged, {}, container);

        var returned = instance.updateView(context);

        if (returned !== undefined) {
            status.textContent =
                'updateView returned a value — this is a virtual control, and this page cannot render one. Use npm start and npm run smoke.';

            return;
        }

        document.getElementById('harness-value').value = columnValue === null ? '' : String(columnValue);

        /*
         * One delegated listener, not a list of ids.
         *
         * This was a hand-maintained array, and the array is the bug: a switch
         * added to `harness.html` and to `options()` but forgotten here renders
         * perfectly, reads correctly, and never triggers an update — so it
         * appears to do nothing, or worse, appears to work the moment any
         * *other* switch is touched. Six switches shipped in that state.
         *
         * Delegating to the panel covers every control in it, including ones
         * added later, and `change` bubbles from `select` and `input` alike.
         * The text field has its own `input` handler below for the same reason
         * it always did — typing is a different event from committing.
         */
        document.querySelector('.harness-controls').addEventListener('change', render);

        // Typed into the field's *column*, not into the control — this is the
        // platform handing down a new bound value, which is a different event
        // from the user typing and hits a different branch.
        document.getElementById('harness-value').addEventListener('input', function (event) {
            columnValue = event.target.value;
            render();
        });

        /*
         * `null`, not `''`. A cleared column and an empty string are different
         * values, and a control that renders them the same way is usually fine
         * while one that *writes* them the same way is not.
         */
        document.getElementById('harness-clear').addEventListener('click', function () {
            columnValue = null;
            document.getElementById('harness-value').value = '';
            render();
        });

        // The cheapest way to catch work that belongs behind a comparison:
        // press it and watch whether anything moves.
        document.getElementById('harness-rerender').addEventListener('click', render);

        status.textContent = 'Registered ' + registration.name + '.';

        render();
    };
})();
