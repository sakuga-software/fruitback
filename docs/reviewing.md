# Reviewing a site with the extension

This is the reviewer's side. The site's side and the worker's are in [install.md](install.md); which
mode you want is in [modes.md](modes.md).

Both extension modes start the same way — install it, switch an origin on — and diverge on one
question: **does that site embed the widget itself?** If it does, that is team mode and you will pair
with the worker. If it does not, that is private mode and the extension mounts the widget for you.

## 1. Install it

The extension is **not published to a store yet**. Build it from this repository and load it
unpacked:

```bash
pnpm install
pnpm --filter @fruitback/extension build           # or build:firefox
```

That writes `apps/extension/.output/chrome-mv3/`. In Chromium, open `chrome://extensions`, turn on
**Developer mode**, choose **Load unpacked** and pick that directory. `pnpm --filter
@fruitback/extension dev` does the same with a reload on every change, which is what you want if you
are working on the extension rather than using it.

**It asks for no host permission at install**, and that is deliberate: it can read nothing anywhere
until you switch a site on, and it asks then, for that origin. Chromium will say the extension can
read and change data on the site you name — that is the grant, and it is what lets a content script
run there.

## 2. Switch a site on

Open the page you want to review and click the extension. The popup names the origin it is about,
and asks for three things:

| Field | | |
| --- | --- | --- |
| **Mode** | `Private · the extension mounts the widget` | for a site that embeds nothing |
| | `Team · the site embeds it, we relay` | for a site that ships a dormant widget |
| **Worker endpoint** | `https://feedback.acme.dev` | your worker, not the site |
| **Client id** | `acme` | **private mode only** — in team mode the site declares its own |

Then **Turn on for this site**. The browser asks for permission on that origin; refuse it and nothing
runs. The row afterwards reads `On · acme` in private mode, and in team mode
`On · team mode · the site's own widget` — where the client id would be, because there the site
declares its own. Either row carries **Turn off here** and **Change**.

A grant reaches the **next** page load, so the popup injects into the tab you have open. Come back to
the page and the widget is there.

The endpoint must be `https`, or loopback for the dev loop. That rule is the worker's and the
popup's: a session is a bearer credential and it does not cross plain `http`.

## 3. Pair, in team mode

Private mode needs nothing more — the widget is mounted, and it reads as an anonymous visitor would.
Team mode relays every call through your session, so until you pair the site can reach nothing:

> Not paired — this site cannot reach the worker until you do

**A pairing code is minted by an operator, on the container, never over HTTP:**

```bash
docker compose exec worker node server.mjs pair --subject alex@acme.dev --name "Alex"
```

The name in that command is what your notes will be signed with. The worker vouches for it because
an operator typed it; the browser never asserts its own identity, which is the whole reason the code
comes from a person rather than a form.

Paste it into **Pair with this worker**. The popup then reads `Paired as Alex`, with **Log out**
beside it. If it does not:

| | |
| --- | --- |
| `That code has been used or has expired. Ask for a new one.` | Codes are single-use, and expire 15 minutes after they are minted. |
| `The worker did not answer. Try again.` | The worker is down or unreachable — the code is still good. |
| `That worker is on plain http. A session must not cross it.` | Use `https`, or loopback. |
| `Fruitback needs permission to reach that worker.` | The prompt for the **worker's** origin was refused. It is not the site's. |

Pairing asks for a permission on the worker's origin, which is a different grant from the site's. It
is asked for at the click, so nothing is awaited before the prompt — a browser drops the gesture
otherwise and no prompt ever appears.

## What log out does, and what it cannot undo

**Log out** revokes the session on the worker first, then clears both tokens here. The refresh token
is dead and the chain with it, so nothing can be renewed. The access token already minted is not
reachable by a revoke — nothing checks a list when one is presented — and it stops working on its
own. That window is the token's **11 minutes**: its 10 minutes of life, plus the 60 seconds of clock
skew the verifier allows past the moment it expires. Raised in review, which counted the lifetime
and found the document counting one minute less than the code.

If the worker cannot be reached, the tokens are cleared here anyway. A screen saying signed out over
a credential this extension still holds would be the worse of the two, and the token on the worker
expires within 30 days regardless.

## What the extension never does

- **It does not put a token in the page.** The access token lives in the extension's trusted
  contexts, and the widget asks the background to make the call. A page can forge messages on the
  bridge and still cannot ask for one.
- **It does not relay to a worker the page did not name.** A page declaring another endpoint is
  refused rather than answered with your credential for a worker nobody on that page chose.
- **It does not reach a site you have not switched on.** Content scripts are registered per origin,
  at runtime, and unregistered when you switch it off.

The full list, and what each refusal is for, is in
[SECURITY.md](../SECURITY.md#what-the-extension-relays-and-what-it-refuses-to).
