---
'@fruitback/worker': minor
---

A client that connects from a page, as a connector of claude.ai, gets a token for `/mcp` by OAuth 2.1: discovery by `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, open registration of clients, PKCE with S256, a person who approves in the console, an access token of one hour and a refresh token spent once. A connection is an agent key with no secret, listed and revoked with the others. Where OAuth is on (accounts, `FRUITBACK_PUBLIC_URL` and `FRUITBACK_CONSOLE_URL`), `/mcp` answers `401` with `WWW-Authenticate` in place of `404` to a request it refuses. Migration `0038_oauth_connections`.
