#!/usr/bin/env node
/**
 * Adopt this template: replace every placeholder, rename the files that carry
 * one, and generate the identifiers that must be unique per repository.
 *
 *   node scripts/setup.mjs
 *   node scripts/setup.mjs --yes \
 *     --control ColorPicker --namespace PCFHub --slug pcf-color-picker \
 *     --title "Color Picker" --tagline "A WCAG-compliant colour picker." \
 *     --category pickers --owner pcfhub --repo pcf-color-picker \
 *     --publisher PCFHub --prefix pcfhub
 *
 * Under `--yes` every value must be answerable without a prompt, and TAGLINE,
 * CATEGORY and OWNER have no `derive` — so a short example that omits them does
 * not "use the defaults", it exits 1. SLUG derives from CONTROL as
 * `color-picker`, which is probably not the slug you want either.
 *
 * Add `--framework react` for a React (virtual) control instead of a standard
 * DOM one; see applyFramework() below for exactly what that changes.
 *
 * Add `--type dataset` for a control that binds a view rather than a column;
 * see applyType(). All four combinations are supported — a plain DOM table is a
 * perfectly reasonable dataset control — and the two flags are not two ways of
 * asking the same question. A React *dataset* control is `type: "dataset"` and
 * `framework: "react_virtual"`, because the hub resolves dataset ahead of
 * virtual.
 *
 * Run it once, review the diff, commit. `scripts/check-template.mjs` fails the
 * build until it has been run, so a half-adopted template cannot reach a
 * release — which matters because two of the values below (the solution's
 * unique name and the publisher prefix) are permanent once a customer has
 * installed the solution.
 */

import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Never walked: build output, dependencies, and git's own storage. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'bin', 'obj', 'generated']);

/**
 * React and Fluent are resolved by the host at runtime, not bundled, so these
 * are devDependencies. The React version is not arbitrary: pcf-scripts maps a
 * declared 16.8–16.14.0 onto the platform's 16.14.0 build, and
 * @fluentui/react-components requires react >=16.14.0 — so pinning 16.8.6 here
 * makes `npm install` refuse the pair even though both resolve identically at
 * runtime.
 */
const REACT_VERSION = '16.14.0';
const FLUENT_VERSION = '9.46.2';

/**
 * Grid customizers are Fluent 8, and that is not a version left behind.
 *
 * A cell renderer is mounted per cell by the grid, with nothing of the
 * customizer's above it — so there is nowhere to put a `FluentProvider`, which
 * Fluent 9 requires before any component is themed. Fluent 8 styles without a
 * provider, which is why Microsoft's grid customizer template is on it and why
 * this variant follows.
 */
const FLUENT8_PACKAGE = '@fluentui/react';
const FLUENT8_VERSION = '8.121.1';

/** Binary-ish or generated files whose contents must not be rewritten. */
const SKIP_FILES = new Set(['package-lock.json']);

const args = parseArgs(process.argv.slice(2));

const framework = args.framework ?? 'standard';

if (framework !== 'standard' && framework !== 'react') {
    fail(`--framework must be "standard" or "react", not "${framework}".`);
}

/*
 * What the control binds: one column, a collection, or — in the third case —
 * nothing at all.
 *
 * A flag rather than an eleventh question, so `--yes` still requires exactly the
 * same ten values and the interactive path is unchanged.
 *
 * `field` and `dataset` compose freely with --framework; all four combinations
 * are supported. `grid-customizer` does not, and the reason is worth stating
 * because it looks like an omission: a customizer's overrides *return React
 * elements* — that is the platform's interface, not a choice — and they are
 * rendered by the host's own React instance, which is what `control-type
 * ="virtual"` plus the platform-library declarations arrange. A standard DOM
 * customizer is not a thing the contract can express.
 */
const type = args.type ?? 'field';
const TYPES = ['field', 'dataset', 'grid-customizer'];

if (!TYPES.includes(type)) {
    fail(`--type must be one of: ${TYPES.join(', ')} — not "${type}".`);
}

if (type === 'grid-customizer' && args.framework === 'standard') {
    fail(
        'A grid customizer is always a React (virtual) control: its cell renderers and ' +
        'editors return React elements by contract. Drop --framework standard.',
    );
}

const rules = {
    CONTROL: {
        question: 'Control name (PascalCase, becomes the constructor)',
        example: 'ColorPicker',
        test: /^[A-Za-z][A-Za-z0-9_]*$/,
        hint: 'letters, digits and underscores, starting with a letter',
    },
    NAMESPACE: {
        question: 'Namespace',
        example: 'PCFHub',
        test: /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/,
        hint: 'a PCF namespace such as "PCFHub" or "Contoso.Controls"',
    },
    SLUG: {
        question: 'Hub slug (the /components/… URL, and the pcfhub.json slug)',
        derive: (a) => kebab(a.CONTROL),
        test: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        hint: 'lowercase words separated by single hyphens',
    },
    TITLE: {
        question: 'Display name',
        derive: (a) => title(a.CONTROL),
        test: /^.{1,191}$/,
        hint: 'up to 191 characters',
    },
    TAGLINE: {
        question: 'One-line description',
        example: 'A WCAG-compliant colour picker for model-driven forms.',
        test: /^.{1,255}$/,
        hint: 'up to 255 characters',
    },
    CATEGORY: {
        question: 'Hub category slug',
        example: 'pickers',
        test: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        hint: 'lowercase words separated by single hyphens',
    },
    OWNER: {
        question: 'GitHub owner',
        example: 'pcfhub',
        test: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/,
        hint: 'a GitHub user or organisation',
    },
    REPO: {
        question: 'GitHub repository name',
        derive: (a) => a.SLUG,
        test: /^[A-Za-z0-9._-]+$/,
        hint: 'the repository name only, not the URL',
    },
    PUBLISHER: {
        question: 'Dataverse publisher unique name (permanent)',
        derive: (a) => a.NAMESPACE.replace(/\./g, ''),
        test: /^[A-Za-z][A-Za-z0-9]*$/,
        hint: 'letters and digits, starting with a letter',
    },
    PREFIX: {
        question: 'Publisher customization prefix (permanent, 2–8 chars)',
        derive: (a) => a.PUBLISHER.toLowerCase().slice(0, 5),
        test: /^[a-z][a-z0-9]{1,7}$/,
        hint: '2 to 8 lowercase characters, starting with a letter',
    },
};

const answers = {};

const rl = args.yes ? null : createInterface({ input: process.stdin, output: process.stdout });

for (const [token, rule] of Object.entries(rules)) {
    const fallback = args[token.toLowerCase()] ?? rule.derive?.(answers) ?? null;

    for (;;) {
        let value = fallback;

        if (rl) {
            const suffix = fallback ? ` [${fallback}]` : rule.example ? ` (e.g. ${rule.example})` : '';
            const typed = (await rl.question(`${rule.question}${suffix}: `)).trim();
            value = typed === '' ? fallback : typed;
        }

        if (value && rule.test.test(value)) {
            answers[token] = value;
            break;
        }

        const problem = value ? `"${value}" is not valid — expected ${rule.hint}.` : 'A value is required.';

        if (!rl) {
            fail(`${token}: ${problem}`);
        }

        console.error(`  ${problem}`);
    }
}

rl?.close();

/*
 * Generated rather than asked for.
 *
 * The two project GUIDs only have to be unique, and the option-value prefix
 * only has to not collide with another publisher in the same environment —
 * nobody has an opinion about any of them, and a template that ships fixed ones
 * gives every repository the same identity.
 */
answers.PCF_PROJECT_GUID = randomUUID();
answers.SOLUTION_PROJECT_GUID = randomUUID();
answers.OPTION_VALUE_PREFIX = String(10000 + Math.floor(Math.random() * 90000));

const tokens = Object.keys(answers).map((name) => [`__${name}__`, answers[name]]);

// Longest first, so `LinkField` cannot eat the front of a longer token that
// happens to share its prefix.
tokens.sort((a, b) => b[0].length - a[0].length);

const rewritten = [];
const renamed = [];

for (const file of walk(root)) {
    const original = readFileSync(file, 'utf8');
    let updated = original;

    for (const [token, value] of tokens) {
        updated = updated.split(token).join(value);
    }

    if (updated !== original) {
        writeFileSync(file, updated);
        rewritten.push(relative(file));
    }
}

/*
 * Depth-first, children before parents — which is the order `walkPaths` already
 * yields, and the reason it yields a directory *after* recursing into it.
 *
 * The paths were collected before the first rename, so renaming a parent early
 * would invalidate every path still queued underneath it.
 */
for (const path of walkPaths(root)) {
    const base = basename(path);
    let next = base;

    for (const [token, value] of tokens) {
        next = next.split(token).join(value);
    }

    if (next !== base) {
        const target = join(dirname(path), next);
        renameSync(path, target);
        renamed.push(`${relative(path)} → ${next}`);
    }
}

/*
 * Order matters here, and not incidentally.
 *
 * applyType() runs first because the dataset manifest it copies in ships
 * `control-type="standard"` and a `<resx path=` line — exactly like the field
 * manifest — so applyFramework()'s react patch then lands on it unchanged. The
 * other order would need a second copy of that patch, and two copies of a patch
 * are two patches that drift.
 */
applyType(answers.CONTROL);
applyFramework(answers.CONTROL);

/*
 * The variants directory has done its job either way — the react sources have
 * been copied into place, or they were never wanted. Leaving it behind would
 * ship a second, unreferenced copy of the control in every adopted repository.
 */
rmSync(join(root, 'variants'), { recursive: true, force: true });

/*
 * `migration.md` ships with `appliesTo: ">=1.0.0"`, which matches no release of
 * a control that starts at 0.1.0. The hub reports the range as matching nothing
 * and skips the page, and `check-template.mjs` cannot catch it because it only
 * validates filenames. There is nothing to migrate from on a new control, so
 * the page is removed rather than shipped broken. Write it when the first
 * breaking change lands.
 */
rmSync(join(root, 'docs', 'migration.md'), { force: true });

/*
 * adopt.mjs copies this template into a repository that already exists. A
 * repository scaffolded *from* the template has already had that done to it, so
 * the script has no second act here — and it carries a literal LinkField in
 * its own comments, which is exactly what check-template.mjs fails on.
 */
rmSync(join(root, 'scripts', 'adopt.mjs'), { force: true });

/*
 * `add-control.mjs` adds a *second* control to a repository that has already
 * been adopted, and it runs from the template for the reason its own header
 * gives: the sibling's sources come out of `variants/`, which the removal
 * above has taken. A copy sitting in an adopted repository would have nothing
 * left to copy from, and would carry placeholder tokens that this script's own
 * leftover-token check then fails on.
 *
 * So it stays a template-side tool, exactly like `adopt.mjs`. Reach it as
 * `node ../_template/scripts/add-control.mjs --into .` from the repository that
 * is gaining the control.
 */
rmSync(join(root, 'scripts', 'add-control.mjs'), { force: true });

/*
 * `verify-adoption.mjs` tests *this script*, by adopting the template into a
 * scratch directory and asserting what comes out. An adopted repository is the
 * output, not the subject, so it has no use for it — and carrying it would ship
 * a file that talks about placeholder tokens, which its own leftover-token
 * check would then flag.
 */
rmSync(join(root, 'scripts', 'verify-adoption.mjs'), { force: true });

/*
 * `release-reusable.yml` is the shared pipeline, and it lives *here*. Every
 * component repository calls it by `uses:` at the `@v1` tag rather than owning
 * a copy, so an adopted repository carrying one would hold a second definition
 * of the release — unreferenced by its own release.yml, and drifting from this
 * one the moment either is fixed.
 *
 * Which is exactly the state eleven repositories were in before P6 migrated
 * them. Deleting it here is what stops the next adoption quietly recreating it.
 */
rmSync(join(root, '.github', 'workflows', 'release-reusable.yml'), { force: true });

/*
 * `build-reusable.yml` is the same arrangement, arrived at a second time and for
 * the same reason: build.yml *was* the copied-per-repository file, and by the
 * time it was shared, thirteen of fifteen repositories were still pinning
 * actions on a Node runtime GitHub had begun retiring, eleven ran no smoke
 * suite, and two checked no bundle size. Nothing had gone wrong; nobody had
 * edited fifteen files in one sitting, which is the same thing.
 *
 * So it is deleted here for exactly the reason its release counterpart is.
 */
rmSync(join(root, '.github', 'workflows', 'build-reusable.yml'), { force: true });

/*
 * The template calls the shared build locally — `./.github/workflows/…`, which
 * resolves against the calling commit, so its own CI tests the working tree.
 * An adopted repository has no copy to resolve, so it has to point at the tag.
 *
 * `adopt-first` goes with it: it is true only in a repository that still has
 * placeholders to replace, and this script has just replaced them.
 *
 * **The comment goes too, and that is not tidiness.** The version of this
 * script before P7 rewrote the `uses:` line and left the paragraph above it
 * explaining that the reference was local and that setup.mjs would rewrite it —
 * a file describing, in an adopted repository, a state that only exists in the
 * template. That is the same failure as the comment which explained
 * placeholders using a placeholder, and verify-adoption.mjs exists because
 * neither is visible from inside the template.
 */
edit('.github/workflows/build.yml', (text) =>
    text
        .replace(
            /# TEMPLATE-ONLY NOTE[\s\S]*?# END TEMPLATE-ONLY NOTE\n/,
            '# Pinned to @v1 rather than @main — a build that can change without\n'
                + '# warning is one you cannot bisect. The shared workflow lives in\n'
                + '# pcfhub/_template; open an issue there rather than forking a copy back\n'
                + '# into this repository, which is the drift it was built to end.\n'
                + '#\n'
                + '# Every input it takes defaults to the strict value. If this repository\n'
                + '# ever needs to skip a step — no dev/ directory, so no smoke suite —\n'
                + '# say so here with a comment, where a reader will find it.\n',
        )
        .replace(
            'uses: ./.github/workflows/build-reusable.yml',
            'uses: pcfhub/_template/.github/workflows/build-reusable.yml@v1',
        )
        .replace(/\n    with:\n      adopt-first: true\n/, '\n'),
);

const templateDoc = join(root, 'TEMPLATE.md');

if (existsSync(templateDoc)) {
    rmSync(templateDoc);
}

console.log('');
for (const [token, value] of tokens) {
    console.log(`  ${token.padEnd(24)} ${value}`);
}
console.log(`\n  ${rewritten.length} files rewritten, ${renamed.length} renamed:`);
for (const line of renamed) {
    console.log(`    ${line}`);
}

console.log(`
Adopted as a ${type === 'grid-customizer' ? 'react_virtual grid-customizer' : `${framework} ${type}`} control.

Next:
  1. Review the diff — the publisher prefix and the solution unique name are
     permanent once this ships.
  2. npm install — then COMMIT package-lock.json. Both workflows run "npm ci",
     which fails outright without it, and this template ships none.
  3. npm run build
  4. Fill in docs/*.md. Every file there becomes a page on the hub; the ones you
     do not write simply do not appear.
  5. Replace media/logo.png — the one here is a placeholder, and nothing in CI
     checks what it looks like.
  6. Add the repository to PCFHub with the slug "${answers.SLUG}", then tag v0.1.0.${type === 'dataset' ? `
  7. Replace demo/records.json with a fixture that looks like your view, then
     set demo.datasetFixture and demo.fidelity in pcfhub.json.` : ''}${type === 'grid-customizer' ? `
  7. Write your overrides in ${answers.CONTROL}/customizers/. Both files ship one
     worked example and the rules the grid actually enforces; the examples are
     meant to be replaced, the rules are not.
  8. Add demo/<rows>.json and point demo.datasetFixture at it, then raise
     demo.fidelity from "none" to "mocked". demo.host is already "grid": the
     harness renders a grid over that fixture and calls your overrides per cell,
     so without a fixture the grid draws empty and none of them ever run.
     "mocked" is the ceiling — the harness's grid is a stand-in, and what it
     does not exercise (the GridCustomizer interface, PAGridAPI, server-side
     sort/filter/paging, validation state) belongs in demo.limitations.
  9. THE STEP EVERYONE MISSES: importing the solution does nothing on its own.
     Assign the control at Settings > Customizations > the table > Controls >
     Power Apps grid control > Customizer control = {prefix}_${answers.NAMESPACE}.${answers.CONTROL}
     Until then it is installed, inert, and logs nothing to say so.` : ''}
`);

// ------------------------------------------------------------------ helpers

/**
 * Turn the bound-column control into a dataset one.
 *
 * A dataset control binds a collection rather than a column, and almost nothing
 * about the entry point survives that change — so unlike applyFramework(), this
 * replaces the control's source outright rather than patching it.
 *
 * What it deliberately does *not* touch: `control-type`, which stays
 * "standard", and the `<resx path=` line. Both are what applyFramework()'s
 * react patch matches on, so running that afterwards needs no dataset-specific
 * branch of its own.
 *
 * The variant it copies from ships no `property-set` roles. That is a decision
 * the manifest's own comments explain, and one worth revisiting per control:
 * roles are right when specific columns play specific parts, and wrong when the
 * control renders whatever the view supplies.
 */
function applyType(control) {
    if (type === 'grid-customizer') {
        applyGridCustomizer(control);
        return;
    }

    if (type !== 'dataset') {
        return;
    }

    const source = join(root, 'variants', 'dataset');
    const target = join(root, control);

    cpSync(join(source, 'ControlManifest.Input.xml'), join(target, 'ControlManifest.Input.xml'));
    cpSync(join(source, 'index.ts'), join(target, 'index.ts'));
    cpSync(join(source, 'css'), join(target, 'css'), { recursive: true });
    cpSync(join(source, 'strings'), join(target, 'strings'), { recursive: true });

    // api.md loses `kind=bound` and gains `kind=dataset` — a dataset control
    // binds no column, so the shipped section would render an empty table.
    cpSync(join(source, 'docs', 'api.md'), join(root, 'docs', 'api.md'));

    // A starter fixture, so `demo.datasetFixture` has something to point at.
    // Only dataset controls get one: the hub reads it for nothing else.
    cpSync(join(source, 'demo'), join(root, 'demo'), { recursive: true });

    /*
     * The dev rig, overlaid rather than replacing: `dev/dom.js` is the same
     * file for every DOM shape and stays where the field variant put it, while
     * the host, the fixture, the page and the assertions are all dataset-shaped
     * and land on top.
     *
     * What this buys is the thing no other harness gives a dataset control:
     * more than one page. The hub's demo harness seeds a single page and
     * reports no next or previous page, which is why every dataset control in
     * the catalogue is published at fidelity "limited" — so the paging and
     * sorting code, which is most of the hard code in the shape, has never been
     * exercised by anything. See `dev/host.js` for the three real platform
     * misbehaviours it can reproduce on demand.
     */
    cpSync(join(source, 'dev'), join(root, 'dev'), { recursive: true });

    edit('pcfhub.json', (text) =>
        text
            .replace('"type": "field"', '"type": "dataset"')
            /*
             * Point at the fixture that was just copied in.
             *
             * The grid-customizer branch has always done this and the dataset
             * branch never did, so every dataset repo hand-wrote the key — and
             * `npm run check` cannot catch the omission, because a missing
             * `demo.datasetFixture` is only checked when it is present and
             * wrong. Fidelity stays "none": the file existing is a fact, and
             * how faithful the demo is remains the author's call.
             */
            .replace('"fidelity": "none",', '"fidelity": "none",\n    "datasetFixture": "demo/records.json",'));
}

/**
 * Turn the standard DOM control into a React (virtual) one.
 *
 * This is a patch rather than a second full template on purpose: the manifest's
 * comments, the CSS, the resx and the workflows are the same either way, and
 * they are most of what the template is actually for. Duplicating them into a
 * parallel tree guarantees the two drift.
 *
 * Everything here was learned by doing the conversion by hand for
 * pcf-choices-picker. Each edit below is one that build actually required.
 */
/**
 * Turn the bound-column control into a grid customizer.
 *
 * A customizer binds nothing and renders nothing. It is named on a table's
 * Power Apps grid control and hands that grid a table of cell renderers and
 * editors, which the grid then calls per cell — so unlike applyType()'s dataset
 * branch, which swaps the entry point, this replaces the whole control
 * directory and does its own manifest work rather than leaning on
 * applyFramework()'s patch.
 *
 * It does its own manifest work because there is nothing left for that patch to
 * do: the variant's manifest already ships `control-type="virtual"` and both
 * `<platform-library>` lines, at Fluent 8 rather than Fluent 9. Running the
 * react patch over it would fail on a `control-type="standard"` that is not
 * there — which edit() turns into a hard error, correctly.
 *
 * It copies a `demo/` fixture and points `demo.datasetFixture` at it, but still
 * writes `demo.fidelity` as `none`. Those two are not in tension: the fixture is
 * the grid's *rows*, which every customizer needs and every customizer was
 * previously left to invent, while fidelity is a claim about what the hub can
 * honestly show — and only the author knows whether their overrides do anything
 * visible without a real platform behind them. A cell customizer usually raises
 * it to `mocked` on the day it ships; one that reads attribute metadata, or
 * implements the `GridCustomizer` members, may never be able to, because the
 * harness supplies neither. Raising it is a one-line edit either way.
 */
function applyGridCustomizer(control) {
    const source = join(root, 'variants', 'grid-customizer');
    const target = join(root, control);

    cpSync(join(source, 'ControlManifest.Input.xml'), join(target, 'ControlManifest.Input.xml'));
    cpSync(join(source, 'index.ts'), join(target, 'index.ts'));

    // The customizer contract, vendored. There is nothing to install: it is a
    // file inside a samples repository authors are told to clone, and
    // @types/powerapps-component-framework does not carry it. The provenance
    // header on the file is the whole mitigation — re-take it and diff when the
    // grid starts handing over a shape it does not describe.
    cpSync(join(source, 'types.ts'), join(target, 'types.ts'));

    cpSync(join(source, 'customizers'), join(target, 'customizers'), { recursive: true });
    cpSync(join(source, 'css'), join(target, 'css'), { recursive: true });
    cpSync(join(source, 'strings'), join(target, 'strings'), { recursive: true });

    // A local stand-in for the grid, at the repository root rather than inside
    // the control directory — it is not shipped in the bundle and `pcf-scripts`
    // has no reason to look at it.
    //
    // It exists because nothing else can develop this shape. PCFHub's harness
    // renders cells but never calls the `GridCustomizer` members, and carries
    // no attribute metadata; `npm start` hosts the control the way a form would,
    // where a customizer correctly renders nothing. Without this, the only way
    // to see a customizer work is to pack a solution and import it.
    //
    // Replaced outright rather than overlaid, unlike the dataset rig: a
    // customizer touches no DOM — its overrides return React elements — so the
    // field variant's `dom.js` and its form-shaped host would be two files
    // nothing in this repository loads.
    rmSync(join(root, 'dev'), { recursive: true, force: true });
    cpSync(join(source, 'dev'), join(root, 'dev'), { recursive: true });

    // The grid's rows for PCFHub's demo harness. One fixture covering every
    // column type a customizer can key an override on, with a row of nulls and
    // a row of zeroes in it — the two that catch an override treating falsy as
    // empty. Every customizer needs this and every customizer used to write its
    // own; `demo.fidelity` stays the author's call.
    cpSync(join(source, 'demo'), join(root, 'demo'), { recursive: true });

    // api.md keeps only `kind=bound`. A customizer has no inputs and no
    // outputs, and a props-table with nothing in it reads as an unwritten
    // section rather than an empty one.
    cpSync(join(source, 'docs', 'api.md'), join(root, 'docs', 'api.md'));

    // Not a canvas control, and not arguably one: the customizer property
    // exists only on the Power Apps grid control, which canvas does not have.
    rmSync(join(root, 'docs', 'canvas.md'), { force: true });

    edit('pcfhub.json', (text) =>
        text
            // "grid_customizer" — a real fourth value on the hub, and not one
            // the manifest can be read back to. A customizer's manifest is
            // control-type="virtual" with no <data-set>, which is exactly what
            // a React virtual *field* control looks like, so this is the one
            // shape whose type the repository has to state rather than have
            // derived. (It was "virtual" until the hub grew the category.)
            .replace('"type": "field"', '"type": "grid_customizer"')
            .replace('"framework": "standard"', '"framework": "react_virtual"')
            // The demo surface the hub's harness stands up. Without "grid" the
            // harness hosts this the way it hosts a form control — hands it a
            // container, the control returns its empty fragment, and the
            // visitor gets a demo that loads perfectly and shows nothing.
            //
            // Written alongside fidelity "none" on purpose: the host says what
            // this control *is*, and fidelity is still the author's call once
            // they have a fixture. See docs/demo-harness-grid-customizers.md in
            // the hub repository.
            .replace(
                '"fidelity": "none",',
                '"fidelity": "none",\n    "host": "grid",\n    "datasetFixture": "demo/columns.json",',
            ));

    // The `smoke` script and its CI step are not added here any more. Every
    // shape ships a `dev/smoke.js` now, so both live in the shared
    // `package.json` and `build.yml` — which is also the only way the field and
    // dataset rigs could reach CI, since a customizer-only edit could not add
    // them for shapes it never runs on.

    applyReactTooling(FLUENT8_PACKAGE, FLUENT8_VERSION);
}

function applyFramework(control) {
    if (framework !== 'react' || type === 'grid-customizer') {
        return;
    }

    /*
     * The browser half of the dev rig goes, and `dev/smoke.js` stays.
     *
     * `dev/harness.html` loads the built bundle in a plain page, and a virtual
     * control's bundle expects the platform's React *and* Fluent under the
     * globals its `<platform-library>` entries compile them out to.
     * `@fluentui/react-components` ships no UMD build — there is no file to put
     * in a `<script src>`, and adding a bundler to produce one would make the
     * page the thing that needs building. (Grid customizers keep their harness
     * because Fluent 8 does ship one.)
     *
     * Nothing is lost that matters: unlike a customizer, a virtual field or
     * dataset control renders perfectly well under `npm start`. What `npm start`
     * cannot do is *assert*, and `dev/smoke.js` works on this shape unchanged —
     * `updateView` returns an element tree, Fluent is stubbed component by
     * component, and the props the control passed survive for inspection.
     */
    rmSync(join(root, 'dev', 'harness.html'), { force: true });
    rmSync(join(root, 'dev', 'harness.js'), { force: true });

    // The dataset variant carries its own React sources: a dataset control's
    // entry point shares no code with a bound-column one beyond the class
    // shape.
    const source = type === 'dataset'
        ? join(root, 'variants', 'dataset', 'react')
        : join(root, 'variants', 'react');
    const target = join(root, control);

    mkdirSync(join(target, 'components'), { recursive: true });
    cpSync(join(source, 'index.ts'), join(target, 'index.ts'));
    cpSync(join(source, 'components'), join(target, 'components'), { recursive: true });

    // control-type drives which interface the platform expects the class to
    // implement, and pcfhub.json has to agree with it on two keys, not one.
    //
    // `control.type` is the one people miss. The hub's ControlManifestParser
    // resolves dataset -> virtual -> field in that order, so a virtual *field*
    // control is recorded as "virtual" — "field" would be re-derived as
    // "virtual" at every release and quietly disagree with the repository.
    // `npm run check` enforces this now.
    //
    // A virtual *dataset* control stays "dataset" for the same reason, which is
    // why the type replace is skipped rather than merely failing to match:
    // edit() compares whole files, so a chained replace whose first link is a
    // no-op still passes. Written as a branch, this composition is a decision;
    // written as a replace that happens to miss, it would be an accident that
    // works.
    edit('pcfhub.json', (text) => {
        const typed = type === 'dataset'
            ? text
            : text.replace('"type": "field"', '"type": "virtual"');

        return typed.replace('"framework": "standard"', '"framework": "react_virtual"');
    });

    edit(join(control, 'ControlManifest.Input.xml'), (text) =>
        text
            .replace('control-type="standard"', 'control-type="virtual"')
            .replace(
                '<resx path=',
                `<platform-library name="React" version="${REACT_VERSION}" />\n      <platform-library name="Fluent" version="${FLUENT_VERSION}" />\n      <resx path=`,
            ));

    applyReactTooling('@fluentui/react-components', FLUENT_VERSION);
}

/**
 * The dependency and lint changes every React control needs, whichever Fluent
 * it is on.
 *
 * Shared by applyFramework() and the grid-customizer branch of applyType(),
 * which differ only in the Fluent package and version — a customizer is on
 * Fluent 8 for the provider reason given at FLUENT8_VERSION. Two copies of this
 * would be two copies that drift, and the drift would show up as a build error
 * in one scaffolded shape and not the other.
 */
function applyReactTooling(fluentPackage, fluentVersion) {
    edit('package.json', (text) => {
        const pkg = JSON.parse(text);

        pkg.devDependencies = Object.fromEntries(
            Object.entries({
                ...pkg.devDependencies,
                [fluentPackage]: fluentVersion,
                '@types/react': '^16.14.62',
                '@types/react-dom': '^16.9.24',
                'eslint-plugin-react-hooks': '^4.6.0',
                react: REACT_VERSION,
                'react-dom': REACT_VERSION,
            }).sort(([a], [b]) => a.localeCompare(b)),
        );

        return `${JSON.stringify(pkg, null, 2)}\n`;
    });

    // Without the plugin, an `eslint-disable react-hooks/exhaustive-deps`
    // comment fails the build with "Definition for rule was not found" — which
    // reads as a config error rather than a missing dependency.
    edit('.eslintrc.json', (text) => {
        const config = JSON.parse(text);

        config.parserOptions = { ...config.parserOptions, ecmaFeatures: { jsx: true } };
        config.plugins = [...(config.plugins ?? []), 'react-hooks'];
        config.rules = {
            ...config.rules,
            'react-hooks/rules-of-hooks': 'error',
            'react-hooks/exhaustive-deps': 'warn',
        };

        return `${JSON.stringify(config, null, 4)}\n`;
    });
}

function edit(relative, transform) {
    const path = join(root, relative);
    const before = readFileSync(path, 'utf8');
    const after = transform(before);

    // Failing on a no-op is the point: every caller is replacing a string it
    // expects to be there, so "changed nothing" means the template moved and
    // this script did not. Silently carrying on ships a half-adopted file.
    if (after === before) {
        fail(`Could not patch ${relative} — the text this script rewrites was not found.`);
    }

    writeFileSync(path, after);
}

function* walkPaths(dir) {
    for (const entry of readdirSync(dir).sort()) {
        if (SKIP_DIRS.has(entry)) {
            continue;
        }

        const path = join(dir, entry);

        if (statSync(path).isDirectory()) {
            yield* walkPaths(path);
            yield path;
        } else {
            yield path;
        }
    }
}

function* walk(dir) {
    for (const path of walkPaths(dir)) {
        if (!statSync(path).isDirectory() && !SKIP_FILES.has(basename(path))) {
            yield path;
        }
    }
}

function relative(path) {
    return path.slice(root.length + 1).replace(/\\/g, '/');
}

function kebab(value) {
    return value
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[_\s]+/g, '-')
        .toLowerCase();
}

function title(value) {
    return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
}

function parseArgs(argv) {
    const out = {};

    for (let i = 0; i < argv.length; i += 1) {
        if (!argv[i].startsWith('--')) {
            continue;
        }

        const key = argv[i].slice(2);

        if (key === 'yes') {
            out.yes = true;
        } else {
            out[key] = argv[i + 1];
            i += 1;
        }
    }

    return out;
}

function fail(message) {
    console.error(`\n  ${message}\n`);
    process.exit(1);
}
