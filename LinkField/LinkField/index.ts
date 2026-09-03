import { IInputs, IOutputs } from './generated/ManifestTypes';
import { friendly, isFollowable } from '../../shared/url';

/**
 * A URL column, rendered as a link you can actually follow.
 *
 * A text column holding a web address is one of the most common things on a
 * Dataverse form and one of the least useful: the platform renders it as text,
 * so following it means selecting, copying and pasting. This control shows the
 * address as a link, opens it through the platform rather than through the DOM,
 * and keeps an unsaved edit across a form tab switch.
 *
 * Three platform APIs meet here and each one has a trap the types do not show:
 *
 *   - `navigation.openUrl` **returns `void`**. There is no promise, no callback
 *     and no error — so a refused or malformed URL is indistinguishable from a
 *     successful one, and the only defence is to validate before calling. See
 *     `isFollowable` below, which is the security boundary of this control.
 *   - `mode.setControlState` **returns a boolean that matters**. The platform
 *     refuses when it has nowhere to put the state, and a control that assumes
 *     success shows a restored view that was never saved.
 *   - `context.client` is present everywhere, but what it reports is advice
 *     rather than capability — see `render`.
 */
export class LinkField implements ComponentFramework.StandardControl<IInputs, IOutputs> {
    private container!: HTMLDivElement;
    /** The filled surface the input and the trailing button share. */
    private field!: HTMLDivElement;
    private input!: HTMLInputElement;
    private open!: HTMLButtonElement;
    private link!: HTMLAnchorElement;
    private message!: HTMLParagraphElement;
    private notifyOutputChanged!: () => void;

    /** The committed column value, as the platform last handed it over. */
    private value = '';

    /**
     * What the user has typed and not yet saved.
     *
     * Kept apart from `value` on purpose. They differ for exactly as long as an
     * edit is in flight, and that difference is the only thing worth persisting
     * across a remount — restoring a draft identical to the saved value would
     * mark a pristine form dirty for no reason.
     */
    private draft: string | null = null;

    /**
     * Whether the platform accepted the last `setControlState` call.
     *
     * Read for the message under the field, and nothing else. A control that
     * cannot persist is still a working control; it just cannot promise the
     * edit survives a tab switch, and saying so is better than implying it.
     */
    private persists = true;

    public init(
        context: ComponentFramework.Context<IInputs>,
        notifyOutputChanged: () => void,
        state: ComponentFramework.Dictionary,
        container: HTMLDivElement,
    ): void {
        this.container = container;
        this.notifyOutputChanged = notifyOutputChanged;

        /*
         * The third argument, which almost every control names `_state` and
         * ignores.
         *
         * This is the return half of `mode.setControlState`: whatever the
         * previous instance of this control saved, handed back after the
         * platform destroyed and re-created it. The remount that makes it worth
         * having is a **form tab switch** — leaving a tab and coming back is a
         * full teardown, and an in-progress edit is gone without this.
         *
         * Read defensively. It is typed `Dictionary`, which is
         * `{ [key: string]: unknown }`, so every value in it is `unknown` and
         * came from a previous *version* of this control — a shape this build
         * no longer writes is a real possibility after an upgrade.
         */
        const restored = state && typeof state.draft === 'string' ? state.draft : null;

        this.input = document.createElement('input');
        this.input.className = 'LinkField-input';
        this.input.type = 'url';
        this.input.addEventListener('input', this.onInput);
        this.input.addEventListener('keydown', this.onKeyDown);

        /*
         * A button, not an anchor, and this is the decision the whole control
         * turns on.
         *
         * The platform opens URLs through `navigation.openUrl`, which routes
         * through the host — it works inside a canvas app, inside the mobile
         * shell, and inside an iframe where a bare `target="_blank"` is either
         * blocked or escapes the app entirely. An `<a href>` would bypass all of
         * that and would also make a `javascript:` value in the column into a
         * live payload the moment somebody clicked it.
         *
         * The anchor below exists anyway, for the read-only presentation, and it
         * is only ever given a validated `href`. See `render`.
         */
        this.open = document.createElement('button');
        this.open.className = 'LinkField-open';
        this.open.type = 'button';
        this.open.addEventListener('click', this.onOpen);

        this.link = document.createElement('a');
        this.link.className = 'LinkField-link';
        this.link.addEventListener('click', this.onOpen);

        this.message = document.createElement('p');
        this.message.className = 'LinkField-message';

        this.field = document.createElement('div');
        this.field.className = 'LinkField-field';
        this.field.append(this.input, this.link, this.open);

        this.container.classList.add('LinkField');
        this.container.append(this.field, this.message);

        this.draft = restored;
        this.render(context);
    }

    public updateView(context: ComponentFramework.Context<IInputs>): void {
        this.render(context);
    }

    public getOutputs(): IOutputs {
        /*
         * The draft wins while there is one, because the draft is what the user
         * typed. `undefined` rather than `''` clears the column: an empty string
         * is a value the platform will happily store, and a control that writes
         * one turns "no link" into "a link that is blank".
         */
        const current = this.draft !== null ? this.draft : this.value;

        return { value: current === '' ? undefined : current };
    }

    public destroy(): void {
        this.input.removeEventListener('input', this.onInput);
        this.input.removeEventListener('keydown', this.onKeyDown);
        this.open.removeEventListener('click', this.onOpen);
        this.link.removeEventListener('click', this.onOpen);
    }

    // ------------------------------------------------------------- rendering

    private render(context: ComponentFramework.Context<IInputs>): void {
        // Held for the event handlers, which the platform hands no context.
        // Kept fresh on every pass rather than captured once in `init`: the
        // context object is not guaranteed to be the same instance twice, and a
        // stale one reports a state the form has already left.
        this.context = context;

        const parameters = context.parameters;
        const raw = parameters.value.raw;

        /*
         * `security` is undefined on a host that publishes no column-level
         * security — canvas, and `npm start`. Absent is not the same as denied,
         * so every read of it is optional-chained and the permissive branch is
         * the default.
         */
        const security = parameters.value.security;
        const readable = security ? security.readable : true;
        const editable = security ? security.editable : true;
        const disabled = context.mode.isControlDisabled || !editable;

        this.value = typeof raw === 'string' ? raw : '';

        const shown = this.draft !== null ? this.draft : this.value;
        const followable = isFollowable(shown);

        /*
         * What the client can tell us, and what it cannot.
         *
         * `getFormFactor()` is a *number*, and the enum people expect is not the
         * one the platform uses — 1 is desktop, 2 tablet, 3 phone, and 0 means
         * "unknown", which is what a browser on a laptop with a touchscreen can
         * report. So this is read as "is it definitely small" rather than as a
         * switch, and the default branch is the desktop one.
         *
         * `isOffline()` is advice, not a capability check: it reports the
         * platform's belief about connectivity, which a captive portal or a
         * corporate VPN gets wrong in both directions. So it suppresses the
         * *promise* of opening a link rather than the ability to try — the
         * button stays live and the message explains, because a user who knows
         * they have a connection should not be locked out by a wrong guess.
         */
        const client = context.client;
        const offline = client && typeof client.isOffline === 'function' ? client.isOffline() : false;
        const compact = client && typeof client.getFormFactor === 'function' ? client.getFormFactor() === 3 : false;

        this.container.classList.toggle('LinkField--disabled', disabled);
        this.container.classList.toggle('LinkField--compact', compact);

        /*
         * Absent means absent. A host that publishes no theme — canvas, and
         * `npm start` — is not a host that published "light", so the control
         * takes no position and the stylesheet's default applies. Toggling on
         * `=== true` would render light-mode classes on a host that never said,
         * which is the same bug as reading the OS setting.
         */
        const isDarkTheme = context.fluentDesignLanguage?.isDarkTheme;

        if (isDarkTheme !== undefined) {
            this.container.classList.toggle('LinkField--dark', isDarkTheme);
        }

        if (!readable) {
            // A column the user cannot read is not a control with an empty
            // value. Say which it is; the platform will not.
            this.field.hidden = true;
            this.message.textContent = context.resources.getString('LinkField_NoAccess');
            this.message.hidden = false;

            return;
        }

        this.field.hidden = false;

        const label = parameters.linkLabel.raw;
        const text = label && label !== '' ? label : friendly(shown);

        // Read-only shows the link; editable shows the input beside it.
        this.input.hidden = disabled;
        this.link.hidden = !disabled || !followable;

        this.input.value = shown;
        this.input.disabled = disabled;
        this.input.placeholder = parameters.placeholder.raw ?? '';
        this.input.setAttribute('aria-label', context.mode.label || context.resources.getString('LinkField_Name'));

        this.link.textContent = text;
        /*
         * The href is set only for a URL that passed validation, and it is
         * removed rather than blanked otherwise — an `<a>` with `href=""` is a
         * link to the current page, which inside a model-driven form means
         * reloading the form and losing the edit.
         */
        if (followable) {
            this.link.href = shown;
        } else {
            this.link.removeAttribute('href');
        }

        this.open.textContent = context.resources.getString('LinkField_Open');
        this.open.hidden = !followable;
        this.open.disabled = false;
        this.open.setAttribute('aria-label', format(context.resources.getString('LinkField_OpenNamed'), text));

        this.message.hidden = false;
        this.message.textContent = this.messageFor(context, shown, followable, offline);
        this.message.hidden = this.message.textContent === '';
    }

    /**
     * The one line under the field, and the order these are tested in is the
     * order they matter in.
     *
     * At most one message is shown. A stack of them under a single input reads
     * as a broken control, and the platform's own validation error outranks
     * anything this control has to say about connectivity.
     */
    private messageFor(
        context: ComponentFramework.Context<IInputs>,
        shown: string,
        followable: boolean,
        offline: boolean,
    ): string {
        const error = context.parameters.value.errorMessage;

        if (context.parameters.value.error && error) {
            return error;
        }

        if (shown !== '' && !followable) {
            return context.resources.getString('LinkField_Invalid');
        }

        if (followable && offline) {
            return context.resources.getString('LinkField_Offline');
        }

        // Said only while an edit is actually in flight and actually at risk.
        // A control that announces "this will not be saved" on every render is
        // one people stop reading.
        if (this.draft !== null && this.draft !== this.value && !this.persists) {
            return context.resources.getString('LinkField_NotPersisted');
        }

        return '';
    }

    // -------------------------------------------------------------- handlers

    private onInput = (): void => {
        this.draft = this.input.value;
        this.remember();
        this.notifyOutputChanged();
    };

    private onKeyDown = (event: KeyboardEvent): void => {
        // Enter on a URL field means "go", which is what every browser address
        // bar has trained people to expect.
        if (event.key === 'Enter' && isFollowable(this.input.value)) {
            event.preventDefault();
            this.follow(this.input.value);
        }
    };

    private onOpen = (event: MouseEvent): void => {
        /*
         * Always prevented, including on the anchor.
         *
         * The anchor carries a real `href` so it looks and behaves like a link —
         * hover preview, copy link address, open in new tab from the context
         * menu — but a plain click goes through the platform instead, which is
         * the route that works in canvas and on mobile.
         */
        event.preventDefault();

        const shown = this.draft !== null ? this.draft : this.value;

        this.follow(shown);
    };

    private follow(url: string): void {
        if (!isFollowable(url)) {
            return;
        }

        /*
         * Feature-detected, because `navigation`'s members go missing one at a
         * time. The bag itself is present on every host and is typed
         * non-optional, so `context.navigation.openUrl` compiles whether or not
         * the host implements it — the guard has to be written against the type
         * rather than with it.
         */
        const navigation = this.context?.navigation;

        if (navigation && typeof navigation.openUrl === 'function') {
            /*
             * No return value, no promise, no error. Everything that could be
             * checked has been checked before this line, because after it there
             * is nothing to check.
             */
            navigation.openUrl(url);
        }
    }

    /**
     * Hand the in-flight edit to the platform, and believe the answer.
     *
     * Called on every keystroke, which is cheap — the platform is writing to its
     * own in-memory bag, not to the network — and correct: a tab switch can
     * happen between any two characters.
     */
    private remember(): void {
        const mode = this.context?.mode;

        if (!mode || typeof mode.setControlState !== 'function') {
            this.persists = false;

            return;
        }

        // The draft is dropped rather than saved once it matches the column, so
        // returning to the form does not resurrect an edit the user undid.
        const draft = this.draft !== null && this.draft !== this.value ? this.draft : '';

        this.persists = mode.setControlState({ draft }) !== false;
    }

    /** The most recent context, for the handlers, which are not handed one. */
    private context?: ComponentFramework.Context<IInputs>;
}

// ------------------------------------------------------------------ helpers

/** `String.format`, which JavaScript does not have and every .resx needs. */
function format(template: string, ...values: string[]): string {
    return template.replace(/\{(\d+)\}/g, (match, index) => values[Number(index)] ?? match);
}
