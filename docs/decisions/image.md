# The published image

`ghcr.io/<owner>/fruitback-worker`: why the build stage is pinned to `$BUILDPLATFORM`, why every
architecture is checked before anything is pushed, and why no tag — `sha-<commit>` included — is
immutable.

## The published image

- **`ghcr.io/<owner>/fruitback-worker`, and self-hosting stops needing this repository** (SKG-540).
  Building from source on a small VPS means a clone, a pnpm install and a full compilation, which
  fails for lack of memory about as often as it succeeds.
- **The build stage is pinned to `--platform=$BUILDPLATFORM`, and that is what makes arm64 cheap.**
  What the stage produces is one bundled JavaScript file, and those bytes are identical on every
  platform, so emulating `pnpm install` and esbuild buys nothing. Measured cold on the arm64 → amd64
  leg: **27 s with the pin, 1 min 32 s without**. Only the runtime stage is emulated, and all it does
  there is `apk add sqlite`.
- **`linux/arm64` is not a nicety.** A Raspberry Pi and an ARM VPS are ordinary self-hosting, and an
  amd64-only image excludes them with an error that reads like a broken download.
- **`latest` moves on a `v*` tag and never on a merge to `main`**; `main` publishes `edge`. A
  `latest` that followed every merge takes away the one thing a tag is for. `sha-<commit>` is always
  written, which is what a bisect or an incident needs.
- **No tag is immutable, `sha-<commit>` included.** Rebuilding the same commit republishes it under a
  new digest, because `org.opencontainers.image.created` moves. A tag names a commit; only a digest
  names a build, and the README says so rather than promising an immutability the registry does not
  give. Raised in review, against a table that claimed `sha-<commit>` never moves.
- **Publishing is a second workflow, not a job in `ci.yml`.** That file's `image` job builds one
  architecture and `load: true`s it to boot it, and **a multi-platform build cannot be loaded into
  the daemon at all**. The two cannot be merged.
- **`release-image.yml` checks every architecture it publishes, one job each, before anything is
  pushed.** The first version checked only the runner's own — so an arm64 failure in the base image,
  the `apk add` or the healthcheck passed every gate and shipped, **on the architecture the workflow
  exists to serve**. Raised in review. A single-platform build *can* be loaded into the daemon, which
  is what lets the arm64 image be started under binfmt rather than only built; only a multi-platform
  build cannot. The publish job then reads both caches and assembles.
- **The check asserts the image *refuses* `FRUITBACK_STORE=memory`.** `NODE_ENV=production` is what
  refuses it, and a `--target` that stopped at the build stage would drop that with no other symptom.
  Mutation-tested: an image built without the `ENV` line answers `store: memory` and the step fails.
  It matches the `503` and the **variable name**, never the prose beside it — the diagnostic has to
  name the variable and has its own tests, while the wording is free to change, and a check reading
  the wording would go green on a broken image.
- **`ci.yml`'s `image` job stays, and it is not the same job.** It is the only one that runs on a
  **pull request**, which is where a broken Dockerfile has to be caught; this workflow runs after the
  merge. They use different gha cache scopes, so neither evicts the other.
- **A misconfigured worker does not exit — it serves `/health` as `503`.** So the check waits for an
  answer and reads its status; a check that waited for the process to exit would hang until the job
  timed out. That was the first version, and it was measured hanging.
- **Trivy runs with `ignore-unfixed`.** An Alpine CVE with no patch available reddens every release
  for something nobody can act on, and a gate that cannot be satisfied is a gate somebody deletes.
- **`org.opencontainers.image.source` is the one label with an effect** rather than a description:
  GHCR reads it to attach the package to the repository, which is what gives the package its page,
  its README and its licence. The volatile labels come from `docker/metadata-action`, which is the
  only place that knows them.
- **Attaching the package is not publishing it, and conflating the two is a documented install that
  does not work.** A new package inherits the repository's visibility, so on a private repository it
  is private and an unauthenticated `docker pull` answers `denied` — no label changes that. Making it
  public is a manual, one-time change in the package settings, and the README says so above the
  `docker run` rather than leaving a stranger to discover it. Raised in review, twice.
- **`persist-credentials: false` on both checkouts.** `actions/checkout` writes `GITHUB_TOKEN` into
  `.git/config` by default, where any later step can read it — and this workflow's token carries
  `packages: write`. Nothing runs a git command after the checkout, and `docker/login-action` is
  handed the token explicitly.
- The push needs `packages: write`, the attestations need `id-token: write` **and**
  `attestations: write`. A missing one fails at the end of a long build with a 403 that names nothing.
- **The publish leg cannot be proven from a branch.** What was proven locally: both architectures
  build, the manifest list carries both plus a provenance and SBOM attestation each, the image runs
  as `node` with `NODE_ENV=production`, and the smoke script passes against the real image and fails
  against the mutant. Verified by pushing to a throwaway `registry:2` on localhost.

