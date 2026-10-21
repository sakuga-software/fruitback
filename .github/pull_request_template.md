## Summary

<!-- What changes, and why. Link the issue. -->

## Contract and security

- [ ] This changes `packages/shared`. The description says how, and `SEED_VERSION` is bumped if a seed changes shape.
- [ ] This changes the threat model, and `SECURITY.md` says so.

## Test plan

- [ ] `pnpm lint`, `pnpm format`, `pnpm typecheck` and `pnpm test` pass
- [ ] `pnpm e2e` passes
- [ ] The `postgres` check passes in CI: it runs the account store on a real PostgreSQL, if you changed `accounts-postgres.ts`, `postgres.ts` or a migration
- [ ] The `dependencies` check passes in CI: `pnpm audit --prod` finds no advisory in the production dependencies
- [ ] The `changes`, `docker image`, `docker console` and `docker compose` checks pass in CI, or the image checks were skipped by `changes` because no file of their images changed: they build the images, plant a pin through `docker-compose.yml`, and restore a snapshot of the database
- [ ] The `zizmor` check passes in CI: it audits the workflows

<!-- What you checked by hand, and what you could not check. "Not checked in a browser, because …" is a useful line. -->
