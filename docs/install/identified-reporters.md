# Identified reporters

By default a reporter is anonymous, and a name typed into the popover is stored as a **claim** — a
tracker shows it as _self-declared_. On a site of the console, a reporter is **verified** in one case:
a member of the workspace whose extension is connected, in team mode. The worker sets the flag, and
removes it from anything a browser sends.

**Do not pass `init({ identityToken })` on a site of the console: the worker has no key to verify the
token with, and the note is refused.** The option exists for a site that already knows who its
visitor is: its backend mints a short-lived **HS256 JWT** (`sub`, an `exp`, and optionally `name` and
`email`) and hands it to the widget, which sends it in the `Authorization` header and never inside the
seed. This is what it looks like, for the day a site of the console gets a key:

```ts
init({
  endpoint: WORKER_URL,
  clientId: 'site_…',
  // Called before every write, so a token that expired mid-session is refreshed rather than refused.
  identityToken: () => fetch('/api/fruitback-token').then((response) => response.text()),
});
```

A token that fails to verify is a `401`, not a silent downgrade to anonymous: measured on 2026-10-16, a note sent
with a token signed by a key of the host answered `401 invalid-identity`, and was not kept. The key was
the `identitySecret` of a client of `FRUITBACK_CLIENTS`, which no worker takes since FRU-225. Whether a
site of the console gets one is not decided (FRU-184).
