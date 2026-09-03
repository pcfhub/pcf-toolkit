# Link Toolkit

Two controls in one solution: `LinkField` (field, standard) and `LinkColumn`
(dataset, standard). The pair exists to render a URL column as a real link on a
form and in a view — and, as a repository, to be the first one in the catalogue
holding more than one control.

## What building it settled

**A repository can hold several controls — but a `.pcfproj` holds exactly one,
and that was learned the hard way.**

The first build of this repository put both controls under one root `.pcfproj`.
`npm run build` produced two bundles and msbuild packed both into one
`ToolkitSolution` zip as separate `CustomControl` root components (`type=66`).
Both observations were real, and the conclusion drawn from them — that the shape
needed no project changes — was wrong. `pac pcf push` refuses it outright:

    Error: Found more than one project source file named 'ControlManifest.Input.xml'.
    Pcf projects should only contain a single source manifest file.

Microsoft's ALM guidance says the same: a solution project references many
component projects, "whereas code component projects may only contain a single
code component". **Two of the three build paths tolerate the violation and the
third — the inner development loop — does not**, so the repository looked
healthy in CI while being unusable day to day.

`findControlFolders`' recursion is a *search for the one control*, not support
for many. Reading an implementation detail as a feature is the whole mistake.

The repository is now one project per control, each nested as
`<Control>/<Control>/` with its own `.pcfproj`, and `Solution.cdsproj`
references both. Two arrangements were tried and rejected on the way:

- **Project file beside the manifest** (no nesting). Builds, then writes every
  control to `out/controls/bundle.js`, because `pcf-scripts` writes into
  `outDir/<control path relative to controlsRoot>` and that path is empty. The
  second control silently overwrote the first.
- **`OutputPath` pointed at the control's own folder.** Fails the pack: the
  solution packer enumerates the subfolders of a referenced project's
  `OutputPath` as controls and reported `out/controls/LinkField/css` as a
  control with no `ControlManifest.xml`.

Also worth knowing: **msbuild overrides `pcfconfig.json`.** The targets pass
`--outDir "$(PcfOutputPath)"`, so under a solution build `outDir` is always
`OutputPath`, and a repository where the two disagree builds to different places
depending on how it was built.

Promoted to the skill as *More than one control in a repository* in
`references/control-patterns.md`.

**`<dependency type="control">` works, and this repository does not use it.**
Its `type` enum has exactly one value, `control`, so the element exists only to
say one control depends on another. It survives the build verbatim —
`ManifestProcessor.processResources` explicitly filters it out of resource-path
rewriting and clones it through, verified by adding one and reading
`out/controls/LinkColumn/ControlManifest.xml`. It was then removed: `LinkField`
and `LinkColumn` are peers, and declaring a dependency that does not exist is the
same class of mistake as declaring a `<uses-feature>` nothing calls.

**Sharing code between two controls duplicates it.** Each control directory is a
separate webpack entry, so `shared/url.ts` is compiled into both bundles. There
is no chunk splitting between controls and no way to ask for one — a control is
served as a single web resource. Sharing here is a decision about consistency
rather than size, which is why the thing shared is the URL allow-list: a security
boundary enforced in two places is a boundary enforced in the weaker of them.

**The hub's ceiling is one component per repository, and it is hard.**
`SyncComponentFromRepository` reads `pcfhub.json` from the repository root only
and fails when its `slug` does not match the component being synced;
`ManifestValidator` requires a single `control` object. There is no `controls`
array. So `LinkColumn` ships in the solution, is installed by the same download,
and does not appear on the hub. Stated in `demo.limitations` and in
`docs/limitations.md`.

## Two bugs this found in the shared tooling

Both were single-control assumptions that had been invisible because no
repository had ever had two controls. Both are fixed in `pcfhub/_template`.

- **The release workflow checked one manifest against the tag.** It read only
  `control-dir`'s. A sibling left at the previous version would ship under a tag
  it did not match — exactly the failure that check exists to prevent.
  Reproduced: with `control-dir: Alpha`, a `Beta` manifest at `1.2.4` passed
  cleanly under tag `1.2.3`.
- **Both workflows size-checked one bundle of two.** `Get-ChildItem … -Recurse |
  Select-Object -First 1` measures whichever directory sorts first. Reproduced:
  a 9 KB `Beta` bundle passed a 5 KB limit because `Alpha` was measured instead.
  The 5 MB Dataverse ceiling is per web resource, so each control needs its own
  check.

`check-template.mjs` had the same shape — its localisation, `<uses-feature>` and
`external-service-usage` checks all derived their control directory from
`pcfhub.json`'s `manifestPath`, which is never the sibling. Now per-control.

## What the dev rig gained

`mode.setControlState` is stubbed in `dev/host.js` for the first time, with
`stateWritable: false` to reproduce a host that takes the call and saves nothing.
`dev/smoke.js`'s `mount()` now passes `options.state` as `init`'s third argument,
which was hard-coded to `{}` — so the *return* half of that API was unreachable
from a suite. Both promoted to `_template`.

## Not verified

Nothing here has been on a real Power App. The pack and the build are proven
locally; the platform's behaviour is not.

- **Whether Dataverse installs both controls from one solution and offers each
  independently in the control picker.** The zip contains both as root
  components, which is as far as a local pack can go.
- **Whether `pac pcf push` succeeds from each control project now that the
  layout is one project per control.** The build and the pack are verified
  locally; the push is not, because `pac` is not reachable from the environment
  this was built in. Run it from `LinkField/` and `LinkColumn/` before trusting
  the inner loop.
- **Whether a form tab switch actually round-trips `mode.setControlState`.** The
  rig models it, and the model is a guess about the shape rather than an
  observation of it. Specifically unknown: whether the platform passes `{}` or
  `undefined` as `init`'s third argument when nothing was saved. The control
  reads it defensively either way.
- **Whether `navigation.openUrl` is present on every host this claims.** The
  skill records that navigation members go missing one at a time; both controls
  feature-detect, so a host without it degrades to a link that does nothing
  rather than throwing — which is itself unverified.
- **Whether `context.client.getFormFactor()` returns 3 on a real phone.** The
  compact surface is keyed on it. `0` (unknown) is a value a touchscreen laptop
  can report, so the desktop branch is the default.
- **Whether the hub's ingestion tolerates a repository whose `out/controls` holds
  two bundles** when `demo.bundle` names one. `npm run check` validates the
  manifest against the live hub and is clean, but ingestion is a different code
  path.
