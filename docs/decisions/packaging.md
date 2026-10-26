# The published packages, and their licences

Five packages, one front door, and the guard that packs all five before it believes any of them.
How they reach npm from a tag. Plus the licence split and the two measurements that decided how it
is asserted.

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

## Publishing to npm (FRU-28)

### The rules, in short

- **A release published on GitHub, with a tag `v*`, publishes the five packages**, from
  `release-npm.yml`. The trigger has no filter of the tag: each job that publishes checks
  `refs/tags/v`. The job `ci` calls `ci.yml` on the tagged commit, `package` packs the five with pnpm, and `publish` sends the tarballs to npm in the
  order of their dependencies, in the environment `npm`, after a person approves. The same tag starts
  the release of the extension and of the image: one version for everything.
- **pnpm packs, npm publishes.** `pnpm pack` writes the version of each `workspace:*` dependency into
  the tarball; `npm publish` of a tarball signs the provenance and speaks OIDC (trusted publishing
  needs npm 11.5.1 or later). A version that npm already has is skipped, so a run that failed in the
  middle runs again.
- **No npm token exists.** Each package names `release-npm.yml` of this repository, in the environment
  `npm`, as its trusted publisher, and npm takes the OIDC token of the run in place of a token. npm
  configures a trusted publisher only on a package that exists: a new package is first published
  once by hand as `0.0.0-stage`, a placeholder, then `npm trust github` names the workflow. The
  steps are below, under « A new package on npm ».
- **Each package names the repository and its directory** (`repository.url`, `repository.directory`).
  npm refuses a provenance that names no repository, or another one. `package.test.ts` reads the
  field back out of each tarball.
- **A change to a published package carries a changeset.** The job `changeset` of `ci.yml`
  (`tools/ci/changeset.ts`) fails a pull request that changes a file of `packages/*`, other than a
  test, and adds no file to `.changeset/`. `pnpm changeset --empty` is the answer for a change that a
  consumer cannot see.
- **One version for the five packages and the four apps** (`fixed` in `.changeset/config.json`,
  private packages versioned and never tagged). The tag of a release is the version of the extension,
  and the stores and npm compare it with their manifests. A release is a pull request
  `chore: version x.y.z` that runs `pnpm changeset version`, which writes each `CHANGELOG.md`; then a
  release `vx.y.z` published on GitHub. « Draft a new release », a new tag `vx.y.z` on the merge
  commit, « Generate release notes », « Publish release »: the release makes the tag, and starts
  `release-npm.yml`, `release-extension.yml` and `release-image.yml` (`release: published`). A tag
  pushed alone starts nothing.

### A new package on npm

Somebody with the right to publish in the org `@fruitback`, on their own machine, with npm 11.15 or
later and two-factor authentication, does it once for each new package:

```bash
npm login
mkdir /tmp/placeholder && cd /tmp/placeholder
npm init --yes --scope=@fruitback   # then set "name", "version": "0.0.0-stage", "license": "MIT"
npm publish --access public          # the placeholder: it makes the package exist
npm trust github @fruitback/<name> --file release-npm.yml --repository sakuga-software/fruitback \
  --environment npm --allow-publish
```

The trusted publisher must publish within 2 days, or npm forgets it: publish the release before then. Since
`0.3.0`, `@sakuga-software/boo` is published the same way.

### The reasons, and what is not done

- **`changeset publish` is not used.** It writes a tag for each package (`fruitback@0.3.0`,
  `@fruitback/shared@0.3.0`) beside the `v0.3.0` that starts the three releases: two conventions of
  tags for one release.
- **`changesets/action` is not used either.** It opens the pull request « Version Packages » with a
  token that writes contents and pull requests, and a title that is no Conventional Commit. The pull
  request `chore: version` is written by hand, with `pnpm changeset version`.
- **`0.3.0` has no `CHANGELOG.md`.** The versions up to it were moved by hand (#216, #514). The
  release `v0.3.0` on GitHub lists its pull requests; the first changelog is the one of the next
  version.
- **A run that stops in the middle leaves some packages on npm.** The order puts `fruitback`, the
  front door, last, so a consumer never installs it before what it depends on. Run the workflow
  again: it skips what npm has.

## Licences

### The rules, in short

- **The guard asserts the `license` field and the LICENSE text, not the presence of a file.** npm
  force-includes a `LICENSE` whatever `files` says, and pnpm copies the workspace root's into any
  package with none of its own — so "the tarball contains a LICENSE" is true even for a package that
  never declared one. `THIRD-PARTY-NOTICES.md` is the opposite case: nothing force-includes it, so
  its `files` entry **is** load-bearing.
- **Each published package ships a README of its own** (FRU-388), the page npm shows for it: its
  name as the title, `npm i <name>`, a minimal example, links to the guides on `fruitback.com`, and
  « ## Licence » that says MIT. npm force-includes a README, so the pack guard reads its text from
  the tarball, as it does for the LICENSE. A link goes to the page of the site (`install.html`), not
  to the `.md`: npm does not rewrite it.
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
