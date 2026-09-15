## Summary

<!-- What changes, and why. Link the issue. -->

## Contract and security

- [ ] This changes `packages/shared`. The description says how, and `SEED_VERSION` is bumped if a seed changes shape.
- [ ] This changes the threat model, and `SECURITY.md` says so.

## Test plan

- [ ] `pnpm lint`, `pnpm format`, `pnpm typecheck` and `pnpm test` pass
- [ ] `pnpm e2e` passes
- [ ] The `docker image` check passes in CI: it builds the worker image and plants a pin through `docker-compose.yml`

<!-- What you checked by hand, and what you could not check. "Not checked in a browser, because …" is a useful line. -->
