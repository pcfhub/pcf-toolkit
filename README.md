# Link Toolkit

Render a URL column as a real link, on a form and in a view.

[![Build](https://github.com/pcfhub/pcf-toolkit/actions/workflows/build.yml/badge.svg)](https://github.com/pcfhub/pcf-toolkit/actions/workflows/build.yml)
[![Release](https://github.com/pcfhub/pcf-toolkit/actions/workflows/release.yml/badge.svg)](https://github.com/pcfhub/pcf-toolkit/actions/workflows/release.yml)

Documentation lives on [PCFHub](https://pcfhub.dev/components/pcf-toolkit), built
from the `docs/` directory in this repository. Edit the Markdown here; the hub
recompiles it.

<!--
  This README is for someone standing in the repository — a maintainer, or
  somebody deciding whether to install the control. The hub publishes `docs/`,
  not this file, so do not duplicate the documentation here.

  The three sections below are the ones worth writing by hand. Everything after
  them is the same in every repository and needs no edits.

  **Each carries a placeholder, and `npm run check` fails while one remains.**
  That is deliberate: an unwritten README is the first thing a visitor to the
  repository sees, and the version of this file that shipped before had worked
  examples sitting in it that read as real content. One of them — a bound
  `value` property — was wrong for every control that is not a field control,
  and reached a published repository.

  Delete these comments once the sections are written. They are instructions to
  you, and they are noise on a public page.
-->

## What it does

**Two controls, one solution.** A Dataverse text column holding a web address is
one of the most common things on a form and one of the least useful: the platform
renders it as text, so following it means selecting, copying and pasting. This
repository ships both halves of the fix.

| Control | Binds | What it does |
| --- | --- | --- |
| `PCFHub.LinkField` | one column | Shows the address as a link, opens it through the platform, and keeps an unsaved edit across a form tab switch. |
| `PCFHub.LinkColumn` | a view | The same rule per row: a cell holding a followable address becomes a link, everything else stays text. |

Both are installed by the one solution and can be used independently.

Three things are worth knowing before you read the code.

**Links are opened through `navigation.openUrl`, never through an `href`.** The
anchor carries a real `href` so it behaves like a link — hover preview, copy link
address, open in a new tab — but a plain click is prevented and routed through the
platform. That is what works inside a canvas app, inside the mobile shell, and
inside the iframe a model-driven form is, where an unprevented click navigates the
*form* and loses whatever was being edited.

**Only `http` and `https` are ever followable, and that is a security boundary
rather than tidiness.** `openUrl` hands the string to the host, and a host that
resolves `javascript:` runs it in the app's own origin — so a text column anybody
with write access can edit would become a way to run script in every other user's
session. The rule is an allow-list in `shared/url.ts`, imported by both controls,
because a blocklist is only ever a list of the attacks somebody already thought
of. Both smoke suites assert it against `javascript:`, `data:`, `vbscript:` and
`file:` values.

**An unsaved edit survives a form tab switch.** Moving to another tab and back
destroys the control and creates a new one, so `LinkField` hands its in-flight
edit to `mode.setControlState` and reads it back from `init`'s third argument.
The platform returns `false` when it has nowhere to put that state; the control
says so under the field rather than implying the edit is safe.

<!--
  A few paragraphs, not a feature list. Answer what the built-in control does
  not do, then spend the rest on the one or two decisions a reader would
  otherwise question — the binding shape, a behaviour that looks like a bug
  until you know why, a constraint you chose to accept.

  This is the section that saves an issue being opened.
-->

## Properties

`LinkField` — the control this repository publishes to the hub.

| Property | Type | Usage | Default | What it controls |
| --- | --- | --- | --- | --- |
| `value` | SingleLine.Text | bound, **required** | — | The column holding the address |
| `placeholder` | SingleLine.Text | input | — | Shown in the empty input |
| `linkLabel` | SingleLine.Text | input | — | Text to show instead of the address. Empty shows the site name — the host without `www.` |

`LinkColumn` — the dataset sibling, which the hub does not publish separately.

| Property | Type | Usage | Default | What it controls |
| --- | --- | --- | --- | --- |
| `records` | Dataset | bound | — | The view to render |
| `pageSize` | Whole.None | input | 25 | Rows per page, clamped to 1–250 |
| `openedRecordId` | SingleLine.Text | output | — | The last record opened from the table |

It declares no `property-set` roles: it renders whatever columns the view
supplies and decides per cell whether the value is followable, so there is no
column playing a fixed part for it to name.

**Neither control declares a single `<uses-feature>`.** `navigation` and
`mode` are on the context bag unconditionally, so a maker installing this
solution is asked for no permissions at all, and `external-service-usage` stays
`false` — the control never reaches an external host itself, it asks the
platform to.

The `.resx` ship five languages — English (1033), Spanish (3082), French (1036),
German (1031) and Japanese (1041) — with 1033 listed **last** in each manifest,
because `pcf-start` picks the file by manifest order rather than by locale.
Neither control bundles a framework: both are `standard` DOM controls and read
Fluent's design tokens through `var()`.

<!--
  The whole configuration surface, including the defaults. `docs/api.md`
  generates its tables from the manifest; this one is hand-written, so keep it
  short enough to stay true. Read them out of the manifest rather than from
  memory, and check them against `generated/ManifestTypes.d.ts`.

  A field control's table looks like this — one row per property, and for a
  dataset control a second table for the `property-set` roles above it, giving
  both the display name a maker sees and the manifest name the code looks up by:

      | Property | Type | Usage | Default | What it controls |
      | --- | --- | --- | --- | --- |
      | `value` | SingleLine.Text | bound, **required** | — | The column this control reads and writes |

  Follow it with the notes that do not fit a table: which languages the .resx
  ship, whether the control bundles a framework or uses the platform's, which
  `uses-feature` permissions a maker is asked for at install, and any property
  whose accepted values need spelling out.
-->

## On the hub

`demo.fidelity` is **`limited`**, and it is limited for a reason that cannot be
engineered away: the two APIs this control is *about* are both platform calls the
hub's harness is not in a position to honour.

- **Opening a link does nothing there.** `navigation.openUrl` belongs to the
  host. The demo shows the control deciding to open a URL — which address, and
  whether it was willing to at all — and nothing opens.
- **The unsaved-edit rescue cannot be shown.** It needs a real teardown and
  remount with `mode.setControlState` in between. The harness does not persist,
  so the control takes the honest branch and says the edit will not be kept.

What the demo *does* show is the half worth seeing: which values become links and
which stay text. Type a `javascript:` URL into it and watch the control refuse.

**The demo and the API reference cover `LinkField` only.** PCFHub publishes one
component per repository — one `pcfhub.json`, one slug, one `control` block, one
demo bundle — and this repository builds two controls. `LinkColumn` ships inside
the same solution and is installed by the same download; it is simply not
separately listed on the hub. That is a property of the hub rather than of the
solution, and it is stated in `demo.limitations` so the download page does not
describe half of what it installs.

<!--
  What `demo.fidelity` is, and *why* it is that and not the next one up. A
  `limited` demo should say which interactions do not work there; a `full` one
  is worth explaining, because it follows from the control not reaching Web API,
  device or navigation — which is also one fewer permission prompt for the maker
  installing it.

  Mention what the presets cover. Delete this section if fidelity is `none` —
  and delete the placeholder with it, or the check will go on failing.
-->

## Install

Download the managed solution from the
[latest release](https://github.com/pcfhub/pcf-toolkit/releases/latest), or from
the component's page on the hub, and import it into your environment.

## Develop

```bash
npm install
npm start          # the PCF test harness
npm run build
npm run lint
npm run check      # what CI runs first: placeholders, pcfhub.json, control shape
npm run smoke      # assertions against the built bundle — see dev/
npm run harness    # serves dev/harness.html and opens it
```

`npm start` renders the control; `dev/` is for the states it cannot reach. Build
first, then `npm run smoke` for the assertions, or `npm run harness` for the
switches — field-level security, a failed business rule, a host that publishes
no theme or no column metadata, and for a dataset control, more than one page.
Both read the bundle `npm run build` wrote, and both are described in the header
of `dev/smoke.js`.

`npm run harness` serves the repository over `http://` rather than leaving you to
open the file: over `file://` a dataset fixture cannot be fetched and a module
script is refused, and both arrive as an empty control with a CORS error. It
takes `--port` and `--no-open`, and needs no dependency — `dev/serve.js` is
`node:http`. A React (virtual) control has no harness page, and the script says
so rather than serving a 404.

Run `npm run refreshTypes` after every manifest edit — until you do,
`context.parameters` is typed from the old manifest and `tsc` will accept code that
cannot work.

To pack the solution locally you need msbuild — either Visual Studio or the
Visual Studio Build Tools:

```bash
cd Solution
msbuild /t:build /restore /p:configuration=Release
```

Both zips land in `Solution/bin/Release`. This is the only local step that compiles
in **production** mode, so a green `npm run build` is not evidence the shipping
bundle compiles — and the pack is incremental, so delete `obj/`, `out/`,
`Solution/obj/` and `Solution/bin/` first if you intend to quote a bundle size from
it.

## Release

1. Bump the version in **three** places, in one commit — they are checked
   against each other in CI:
   - `LinkField/ControlManifest.Input.xml` → `<control version="…">`
   - `Solution/src/Other/Solution.xml` → `<Version>`
   - `package.json` → `"version"`
2. Tag it: `git tag v1.2.3 && git push --tags`

The release workflow builds, packs both solution types, and attaches them to a
GitHub Release. PCFHub picks the release up from its webhook within seconds, or
from the hourly sweep otherwise. A sync imports a draft; a person publishes it.

## Repository layout

| Path | What it is |
| --- | --- |
| `LinkField/` | The control: manifest, entry point, CSS, localised strings |
| `Solution/` | The Dataverse solution that packages it |
| `dev/` | A stand-in host: `npm run smoke` asserts, `harness.html` shows |
| `SPEC.md` | What building this corrected, and what is verified versus read |
| `docs/` | The pages PCFHub publishes — see the comments in each file |
| `media/` | Images and video referenced from the docs |
| `pcfhub.json` | The hub's manifest: identity, links, docs path, demo |
| `scripts/` | Template setup and the CI guard that keeps it adopted |

## Licence

[MIT](LICENSE)
