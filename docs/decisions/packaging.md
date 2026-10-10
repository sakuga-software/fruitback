# The published packages, and their licences

Three packages, one front door, and the guard that packs all three before it believes any of them.
Plus the licence split and the two measurements that decided how it is asserted.

## The published package

### The rules, in short

- **Five packages, and only one of them is the front door.** `fruitback` re-exports the two scoped
  ones and **defines nothing** — anything declared there rather than forwarded is a third place for
  the contract to drift. It is not bundled either, so there is one copy of the widget on disk.
- **`init` reads the pins again when the tab is visible again** (FRU-87), if the last read is older
  than the 15 seconds the worker caches a read. That is what replaced a webhook: nothing pushes a
  change of state to an open page. **It does not read while a thread is open**, because `render`
  closes the thread and somebody who comes back to a thread is reading it. The listener is on the
  page's own `document`, and `destroy` removes it.
- **The `workspace` fields point at source; `publishConfig` swaps in `dist` when pnpm packs. All
  five packages need `prepack`.** Miss either and the tarball ships `src` while `publishConfig`
  points at a `dist` that is not there — a failure that lands in a consumer's build and nowhere here.
- **The guard that matters is `package.test.ts`'s test:`type-checks an import with no special tsconfig`.**
  It deletes every `dist`, packs all three, asserts each tarball contains one, installs them into a
  scratch project and type-checks an import from **each** package, with `skipLibCheck` **off**. Every
  clause is there because something without it shipped green. **Read the file after editing this
  guard**: two of those clauses were described here, and in a PR reply, while the edit that would
  have added them had silently not applied.
- **`@fruitback/element` and `@fruitback/react` wrap `init` and define nothing of the contract**
  (FRU-126, FRU-127). The tag reads five attributes and takes the rest through `element.options`; the
  component's props are the options of `init`. **Both exist to not mount twice**: a second mount closes
  the composer and loses what somebody typed. The element mounts once for every change of one task
  (a microtask). The component keys an object by its value and a function by its presence only, and
  the widget calls the function of the last render through a stable one. `createFruitbackElement` is a
  function, never a class at the top of the module: `HTMLElement` is a browser global, and a server
  that renders the page must be able to import the package. The element's script holds the widget, so
  its build copies the widget's `THIRD-PARTY-NOTICES.md` into the tarball, and the guard asserts it.

### The reasons, and the history

- **Three packages, and only one of them is the front door.** `fruitback` is what a client installs:
  it depends on `@fruitback/widget` and `@fruitback/shared` and re-exports both, so mounting the
  widget and naming what it stores is one install and one import.
- The two scoped packages stay published because the front door depends on them, not because anyone
  is expected to reach for them. The contract had to be published at all because the widget's emitted
  `.d.ts` name its types, and types that point at something nobody can install are worse than none.
- **`packages/fruitback` re-exports and defines nothing.** Anything declared there rather than
  forwarded would be a third place for the contract to drift. It is not bundled either: the two
  packages it forwards are real dependencies, so there is one copy of the widget on disk.
- **`public.ts` is the contract, `index.ts` is the workspace.** Everything is exported somewhere
  because the playground and the tests reach into the parts; only what `public.ts` names cannot
  change without a major version. `init` and what it hands back is all of it — deliberately **not**
  the config store, which would be a preference we could never change under a host.
- **`embed.ts` is the only file that knows the worker exists.** `composer.ts` is still handed an
  `onSubmit`; the transport lives in the assembly layer because that is the layer that was always
  going to have to know.
- **`init` patches `history.pushState`/`replaceState`** and restores them on `destroy`. A pin belongs
  to a URL, `popstate` does not fire for a `pushState`, and there is no framework to ask on a client's
  site. The alternative was polling `location.href` for ever.
- The `workspace` fields point at **source**; `publishConfig` swaps in `dist` when pnpm packs. That is
  what lets a developer edit the file they are looking at while a consumer gets the build. **Both
  packages need it** — publishing the contract while `main` still pointed at `src/index.ts` shipped a
  package whose own imports carry the `.ts` extension only this repo allows, and a downstream `tsc`
  failed with `TS5097` while every check here stayed green.
- **`rewriteRelativeImportExtensions` rewrites the JavaScript and not the declarations.** Both builds
  therefore post-process their `.d.ts` and then assert no `.ts` extension survived.
- **All three packages need `prepack`.** `pnpm pack` and `pnpm publish` build through it; without one the
  tarball ships `src` and nothing else, while `publishConfig` points at a `dist` that is not there.
  That is the same defect as the paragraph above, arriving a different way — first as `TS5097`, then
  as an unresolvable module.
- **The guard that matters is test:`type-checks an import with no special tsconfig`**: it deletes every
  `dist`, packs all three, asserts each tarball actually contains one, installs them into a scratch
  project and type-checks an import **from `fruitback` and from both scoped packages**, with
  `skipLibCheck` **off**. Every clause is there because something without it shipped green — building
  before packing hid a missing `prepack`, importing only the widget would have missed a broken
  `exports` on the front door, and `skipLibCheck` skips the declarations the contract package exists
  to make resolvable.
- **Read the file after editing this guard.** Two of those clauses were described here, and in a PR
  reply, while the edit that would have added them had silently not applied. A guard is worth what it
  runs, not what its docstring says.
- `react-grab` and `zod` are **bundled, and are devDependencies**: a client site must not have to
  install — or resolve a version conflict over — a library it never asked for.
- **Bundling them makes their MIT notices our obligation** (FRU-22). MIT asks the notice to travel
  with the code, and both are compiled into `dist`. **Phosphor joined them for the same reason by a
  different route** (FRU-36): the widget installs no icon library, but two of its paths are copied
  into `src/icon-data.ts` and compiled in, and copied geometry is still their work. Like `zod`, the
  package carries no notice of its own — and no `LICENSE` file either — so the text in
  `THIRD-PARTY-NOTICES.md` came from Phosphor's own repository, which `info.json` names. Measured: `react-grab` carries `@license` banners
  esbuild preserves — four survive into the bundle — and **`zod` carries none**, so its notice
  reaches a consumer through `packages/widget/THIRD-PARTY-NOTICES.md` or not at all. `packages/shared`
  is compiled by `tsc` rather than bundled, keeps `zod` as an ordinary dependency, and owes nothing.

## Licences

### The rules, in short

- **The guard asserts the `license` field and the LICENSE text, not the presence of a file.** npm
  force-includes a `LICENSE` whatever `files` says, and pnpm copies the workspace root's into any
  package with none of its own — so "the tarball contains a LICENSE" is true even for a package that
  never declared one. `THIRD-PARTY-NOTICES.md` is the opposite case: nothing force-includes it, so
  its `files` entry **is** load-bearing.
- **The README snippet is read from the README and checked against the build** (`package.test.ts`,
  FRU-26). Every `data-fruitback-*` attribute the landing page tells a reader to write must be one
  the built script actually reads. Before that, the claim in `CLAUDE.md` was an overclaim: the test
  asserted the _build_ named one attribute and nothing had ever opened the file a reader copies from,
  so a renamed attribute left the landing page quietly wrong with a green suite. The built global is
  separately _executed_ on a real page by `e2e/package.spec.ts`.

### The reasons, and the history

- **MIT on the three published packages, AGPL-3.0-only on the worker** (FRU-22). The split follows
  the client/server boundary: the widget is compiled into someone else's site, and copyleft on code
  that ships inside a client's bundle is a licence nobody adopts. The worker is the server, which is
  the only place copyleft bites.
- All three shipped as `UNLICENSED` until this ticket, which is worse than unpublished: a package with
  no licence is one nobody may legally use.
- **The guard asserts the `license` field and the LICENSE text, not the presence of a file** — and
  that is not fussiness, it is what two measurements forced. npm **force-includes** a `LICENSE`
  whatever `files` says, and pnpm **copies the workspace root's LICENSE** into any package that has
  none of its own. So "the tarball contains a file called LICENSE" is true even for a package that
  never declared one. `"LICENSE"` in `files` is documentation, not the mechanism.
- `THIRD-PARTY-NOTICES.md` is the opposite case: npm force-includes nothing by that name, so its
  `files` entry **is** load-bearing. Dropping it was measured failing the guard.
- The ESM build is left readable (the consumer's bundler minifies it); the IIFE is minified because it
  lands on a page exactly as built. **102 kB gzipped** (measured on FRU-38), guarded by a test that trips at 150 kB — a
  tripwire for a dependency that should have been bundled out, not a budget.
- **The README snippet is executed by the suite**, not merely quoted: `package.spec.ts` serves the
  built IIFE through `page.route` and appends the documented tag with its `data-` attributes, which
  is the only way to exercise the auto-mount — `addScriptTag` cannot set attributes. A snippet in a
  doc that nobody runs is a snippet that stops working quietly.
- **`pnpm e2e` builds `dist` first.** `package.spec.ts` loads the real file, and a fresh checkout has
  no build.
