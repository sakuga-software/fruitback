# Identified reporters

By default a reporter is anonymous, and a name typed into the popover is stored as a **claim**: a
tracker shows it as _self-declared_. A visitor with no account is known by a key of their browser,
which lets them edit or delete their own open notes on that browser only.

A site whose people sign in to its own app can do better: its backend signs who the visitor is, and
the worker checks it. Their notes are theirs on every device, and the tracker names them as the site
does, _verified_.

## Turn it on

1. In the console, open the site, then the tab « Access ». Under « How a visitor is recognised »,
   choose « Signed by your site ».
2. Choose « Make the key ». **The key shows once**: copy it into the secrets of your backend.
   Fruitback keeps it sealed and never shows it again. « Make a new key » replaces it at once; the
   tokens signed with the key before then count for nothing.
3. Choose « Save ».

The option needs a site where anybody may leave a note, and an instance with `FRUITBACK_SECRETS_KEY`
set, the key that already seals the keys of the connectors. Without it, the console says so and the
option stays off.

## Sign a token

Your backend mints a short-lived JWT, HS256, signed with the key of the site:

| Claim   | What it holds                                                                      |
| ------- | ---------------------------------------------------------------------------------- |
| `sub`   | Required. The id of your user, as your app knows them. The same on every device.   |
| `exp`   | Required, in seconds. A few minutes is enough: the widget asks before every write. |
| `name`  | Optional. The name the tracker shows for the note.                                 |
| `email` | Optional. The address the tracker shows for the note.                              |

Any JWT library set to HS256 makes the same bytes. In Node:

```ts
import { createHmac } from 'node:crypto';

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function fruitbackToken(user: { id: string; name: string }, key: string): string {
  const head = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode({ sub: user.id, name: user.name, exp: Math.floor(Date.now() / 1000) + 300 });
  const signature = createHmac('sha256', key).update(`${head}.${body}`).digest('base64url');

  return `${head}.${body}.${signature}`;
}
```

Hand it to the widget, from a route of your app that only a signed-in user reaches:

```ts
init({
  endpoint: WORKER_URL,
  clientId: 'site_…',
  // Called before every write, so a token that expired mid-session is refreshed rather than refused.
  identityToken: () => fetch('/api/fruitback-token').then((response) => response.text()),
});
```

The widget sends the token in the `Authorization` header, never inside the note.

## What a token that does not verify does

A token that expired, that another key signed, or that your backend sends after the site stopped
signing, is no identity. The note is still taken, as the note of this browser: the widget keeps its
key of the browser beside the token, and the worker falls back on it. Nothing more is given: the
notes of the person stay theirs, and this browser gets only its own. Your users do not lose a note,
and a broken integration shows as notes with no verified reporter in your tracker.

## Keep the key secret

Whoever holds the key signs any `sub`: they can act on the open notes of your signed users, on this
site only. Keep it on your backend, never in the page. If it leaks, make a new key.
