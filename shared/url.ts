/**
 * The URL rules both controls in this repository obey.
 *
 * **Shared source, not a shared bundle.** `pcf-scripts` builds each control
 * directory into its own `out/controls/<Constructor>/bundle.js`, and each of
 * those is a separate webpack entry — so this module is compiled *into both of
 * them*, once each. There is no chunk splitting between controls and no way to
 * ask for one: a control is served to the platform as a single web resource.
 *
 * That makes sharing here a decision about **consistency, not size**. What it
 * buys is that `LinkField` and `LinkColumn` cannot drift on the one rule that
 * matters, which is the allow-list below. What it costs is the module's bytes,
 * twice. For a page of rules that is obviously the right trade; for a charting
 * library it would not be, and the answer there is that both controls are
 * probably one control with two manifests.
 */

/**
 * Whether this string is a web address a control should be willing to open.
 *
 * **This is the security boundary of both controls, and it is an allow-list for
 * that reason.** `navigation.openUrl` hands the string to the host, and a host
 * that resolves `javascript:` executes it in the app's own origin — so a text
 * column anybody with write access can edit becomes a way to run script in every
 * other user's session. Blocking `javascript:` alone is not enough: `data:` and
 * `vbscript:` reach the same place, and a blocklist is only ever a list of the
 * attacks somebody already thought of.
 *
 * So only `http` and `https` pass. A relative URL is rejected too — it has no
 * meaning outside a page, and inside a model-driven form it resolves against the
 * *form's* URL, which is not what anyone storing a link intended.
 */
export function isFollowable(value: unknown): value is string {
    if (typeof value !== 'string' || value.trim() === '') {
        return false;
    }

    let url: URL;

    try {
        url = new URL(value.trim());
    } catch {
        // Relative, or not a URL at all. For this purpose those are the same
        // answer, and neither is followable.
        return false;
    }

    return url.protocol === 'http:' || url.protocol === 'https:';
}

/**
 * The part of a URL worth showing when there is no label.
 *
 * The host, without `www.`. A full URL in a form field or a grid cell is mostly
 * query string, and a truncated one reads as a broken link rather than a short
 * one. Falls back to the original string, because a value that is not a URL is
 * still something the user typed and hiding it helps nobody.
 */
export function friendly(value: string): string {
    try {
        return new URL(value.trim()).host.replace(/^www\./, '');
    } catch {
        return value;
    }
}
