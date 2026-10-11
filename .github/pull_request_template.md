## Summary

<!-- What changes, and why. Link the issue. -->

## Contract and security

- [ ] This changes `packages/shared`. The description says how, and `SEED_VERSION` is bumped if a seed changes shape.
- [ ] This changes the threat model, and `SECURITY.md` says so.

## Test plan

- [ ] `pnpm lint`, `pnpm format`, `pnpm typecheck` and `pnpm test` pass
- [ ] `pnpm e2e` passes
- [ ] The `postgres` check passes in CI: it runs the account store on a real PostgreSQL, if you changed `accounts-postgres.ts`, `postgres.ts` or a migration
- [ ] The `docker image` check passes in CI: it builds the worker image and plants a pin through `docker-compose.yml`
- [ ] The `zizmor` check passes in CI: it audits the workflows

<!-- What you checked by hand, and what you could not check. "Not checked in a browser, because …" is a useful line. -->
