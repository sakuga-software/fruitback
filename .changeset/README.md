# Changesets

A pull request that changes a package that goes to npm (`packages/*`) adds one file here. The `changeset` job of CI fails without it.

```bash
pnpm changeset          # asks which packages changed, the bump, and one sentence for the changelog
pnpm changeset --empty  # a change that a consumer cannot see: a test, a comment, the build
```

The sentence goes into the `CHANGELOG.md` of each package. Write it for somebody who installs the package, not for the reviewer.

All the packages and the apps have one version (`fixed` in `config.json`). A release is a pull request `chore: version x.y.z` that runs `pnpm changeset version`, then a `vx.y.z` tag on its merge commit: see [docs/decisions/packaging.md](../docs/decisions/packaging.md).
