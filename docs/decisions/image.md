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

## The compose file (SKG-541)

- **It pulls the image, and it is the one file a stranger downloads.** It used to build from the
  repository, and called itself a reference to keep in step by hand with a Dokploy deployment that
  never reads it.
- **`FRUITBACK_IMAGE` is a complete reference, not a tag.** A variable placed after the colon can only
  be a tag, so the digest pin the docs recommend could not be written. Raised in review. Compose does
  not pull a tag it already has, so an update is `docker compose pull` first; `pull_policy: always`
  would make the CI run, which uses a local tag, try the registry.
- **Drift is a test.** `compose.test.ts` reads `WorkerEnv` out of `env.ts` and every `envNames`
  literal out of the connectors. The `worker` service must pass exactly those variables, each from
  `.env`, except three it names with a reason: `NODE_ENV`, `HOST` and `FRUITBACK_FAKE_LINEAR`. `PORT`
  is pinned to `8080`, and the host side reads `FRUITBACK_PORT`. `.env.example` must assign each
  interpolated variable exactly once. Eighteen mutations, the three detectors included, turn it red.
- **The store is a variable, not a compose profile.** The ticket asked for one profile per connector.
  Profiles need one service per connector, and four documented commands say
  `docker compose exec worker`: the SQLite backup in `.env.example` and `self-hosting.md`, and the
  pairing command in `.env.example` and `reviewing.md`. SQLite is the default. Linear is
  `FRUITBACK_STORE=linear` and two keys. GitHub waits for SKG-525.
- **`TRUSTED_PROXY_HOPS` is 0 in this file and 1 in the code.** The file publishes the port with
  nothing in front. The old file said 1 with a published port, which is the forgeable case: each
  forged `X-Forwarded-For` gets a new bucket. Measured, forged reads kept answering `200` past the
  limit with 1, and answered `429` with 0.
- **CI plants a pin through the file.** The `image` job copies only the compose file and
  `.env.example` into an empty directory, and tags the image it built under the name the file pulls.
  Then `plant-a-pin.ts` plants and reads back, the container is recreated, and the pin is read again.
  The recreate proves that the seeds are on the volume.
- **The volume is scoped to the Compose project, and that was decided twice.** A review asked for
  `name: fruitback-data`, so that the compose file and the `docker run` example open the same volume.
  The next review showed the cost: a global name shares the data of every stack on the host, and
  `docker compose down -v` in one stack deletes the other's. Losing data is worse than a documented
  difference, so the name went back to Compose's default and `compose.test.ts` refuses a `name:`.
- **An `.env` from before this file is read differently.** It has no `FRUITBACK_STORE`, says `PORT`
  for the host port and `TRUSTED_PROXY_HOPS=1`. `self-hosting.md` lists the four changes, and
  `.env.example` repeats each one beside its variable.
- **An old SQLite deployment keeps its data in an anonymous volume.** The image declares
  `VOLUME /data`, and the old file mounted nothing there. The new named volume starts empty, so the
  upgrade section copies each database out with `.backup` and back in with `.restore`: the seeds,
  and the sessions when `FRUITBACK_SESSION_PATH` was set. Tested on a stand-in for the old file with
  sessions on: the pin and the pairing code were both back after the restore.
- **The `docker run` example sets `TRUSTED_PROXY_HOPS=0`.** It publishes the port directly, like the
  compose file, and without the variable the worker falls back to 1. The workflows' own `docker run`
  lines are readiness probes on a runner, not commands anybody copies, and were left alone.
- **A shell variable wins over `.env`.** A `LINEAR_API_KEY` exported in a shell profile reached
  `docker compose config` with `.env` empty. The local run of the same check used `env -i`.

## The self-hosting guide (SKG-543)

The ticket turned moved material into a guide that someone who did not write the code can follow.
What it took was mostly measuring, because four things the documentation said were not true.

- **"Each proxy appends to `X-Forwarded-For`" was wrong, in five places.** Measured with the worker
  behind each proxy on a Docker network: Traefik v3.5 and Caddy 2.10 replace the header with the
  address they saw, so a forged `1.2.3.4` never reached the worker. nginx 1.29 with
  `$proxy_add_x_forwarded_for` keeps it and appends. nginx in front of a default Traefik loses the
  client's address, because Traefik overwrites nginx's header with nginx's address; with
  `forwardedHeaders.trustedIPs` set to nginx, Traefik appends and a count of 2 is right. nginx with
  `X-Forwarded-For $remote_addr` replaces, and a count of 2 there answered 20 × `200` then 4 × `429`,
  so the guide's snippet uses it. The first run of that measurement answered nothing: nginx resolves
  `proxy_pass` once at start, and it started before its upstream existed. The sentence
  is gone from `CLAUDE.md`, `SECURITY.md`, `install.md`, `decisions/worker.md` and the old guide. The
  claim that the leftmost entry is correct behind Cloudflare went too: nobody measured it.
- **A wrong count costs different things behind different proxies.** Too high behind nginx, 24
  forged reads all answered `200`. Too high behind Traefik or Caddy, the chain is shorter than the
  count, the worker falls back to the connection's address, and every caller shares the proxy's
  bucket. One caller cannot tell a right count from a shared bucket: both give 20 × `200` then
  4 × `429`. That is why the guide's check has a second step, a read from another network.
- **`/health` checks the configuration, not the store.** A SQLite file in a directory that does not
  exist, and a Linear key that Linear refuses, both answered `200` on `/health` and
  `502 store-unavailable` on the first read. Documented, not changed: a probe that calls the store
  takes the container out of routing during a store outage, when the widget needs the `502` to keep
  the note. It is the same reason `/health` never touches the `Kv`.
- **`install.md` showed `{"ok":true}`.** The answer carries `store`, and `openRead` when a client's
  pins are public.
- **Wrong values the worker accepts**, which the guide documents rather than this ticket changing
  them: `FRUITBACK_HIDE_COMMENTS=true` hides nothing, because only `1` does; `HOST=127.0.0.1` or a
  `PORT` other than the published one leave the container `healthy` and unreachable, because the
  healthcheck probes from inside. `PORT=abc` is the opposite case: `readPort` falls back to 8080, but
  the healthcheck interpolates the raw value, so the container is `unhealthy` while it serves. The
  first version of the guide said it fell back in silence; a review found the healthcheck, and a
  measurement confirmed it.
- **An origin with a trailing slash is accepted at boot and refuses every browser call.**
  `ALLOWED_ORIGINS=https://staging.example.com/` answered `403 origin-not-allowed` to the origin the
  browser sends.
- **The sizing numbers carry their conditions.** One CPU, Apple Silicon under OrbStack, SQLite, and
  the rate limit raised so the load tool was not refused. Reads are served from the 15-second cache,
  so they measure the cache and the JSON. Memory stayed under 200 MiB with a 2 020-pin page.
- **The variable reference is a test.** `compose.test.ts` compares the rows of *Every environment
  variable* with `WorkerEnv`, every store's `envNames` and the compose file's interpolations, and
  checks three defaults against the constants. Four mutations turn it red: a row removed, a row added,
  and a wrong default for the rate limit and for the hop count.
- **The guide was walked literally, by its author.** From an empty directory, under `env -i`, with the
  image served by a local registry: compose up, the curl pin, backup, restore, the proxy check,
  `FRUITBACK_PORT=127.0.0.1:…`, the boot log, `SIGTERM`, and the `docker run` command. The first
  rollback test passed for the wrong reason. `{{index .RepoDigests 0}}` returned
  `fruitback-worker@sha256:…`, a local name, and the rollback found the image still on the machine.
  The guide now greps the registry's line, and the rollback was run again with every local copy of the
  old image deleted: Compose pulled the noted digest, and the pin was still there. What was not done
  is the ticket's own test, a stranger on a clean machine: the package is still private.
- **`.restore` from a missing file erases the database, and reports success.** Found while answering
  a review that asked to stop the worker during a restore. `sqlite3 /data/fruitback.db ".restore
  /data/missing.db"` restored an empty database and exited `0`, and the worker came back `healthy`
  with no pins. The guide's restore ran its copy step and its `.restore` as separate lines, so a
  failed copy was one line away from that. Every documented restore now chains its steps with `&&`
  and checks the file with `test -s` first, and the worker is stopped while it runs. Measured on both
  paths, with Compose and with `docker run`: a good backup gives back its pins, and a missing one
  stops the commands with every pin still there.
- **The migration from before SKG-541 needed the same contract, and a review found two more gaps.**
  Its `break` left the loop and fell through to the `docker compose up` after it, so a failed restore
  still started the worker on the empty volume. And `for db in $dbs` iterates once under zsh, which
  does not split a variable into words. The block now uses `docker compose create`, lists the files in
  the loop, restores in one-off containers, and starts the worker only when a flag says every restore
  succeeded. Measured in bash and zsh: with both files the pin and the pairing code came back; with
  one missing, the worker was created and never started.
