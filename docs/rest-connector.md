# Receiving notes on your own address

A workspace of the Cloud can connect an address of its own. Each note of a site that sends there is
posted to that address, signed. Use it to put notes in a tool Fruitback has no connector for.

**The notes stay in Fruitback too.** Your address only receives: it cannot give a note back to draw
its pin. So the pins, the threads and the list are read from Fruitback, as for a site with no
connector.

This page is the contract your receiver is written against.

## The request

`POST` to the address you gave, over https, with a JSON body:

```json
{
  "version": 1,
  "event": "note.created",
  "workspace": "ws_3f9a…",
  "site": { "id": "site_81c2…", "origin": "https://staging.acme.dev" },
  "identifier": "FB-12",
  "seed": { "note": "The price should say per month.", "page": { "url": "https://staging.acme.dev/pricing" } }
}
```

| Field        | What it is                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------- |
| `version`    | `1`. It moves when a field changes meaning or goes. A new field does not move it.                 |
| `event`      | `note.created`, the one event there is.                                                           |
| `workspace`  | The id of the workspace.                                                                          |
| `site`       | The id of the site, and its origin.                                                               |
| `identifier` | What Fruitback calls the note. The thread of its pin shows it.                                    |
| `seed`       | The whole note, as the widget built it. [What the widget collects](privacy.md) lists every field. |

And these headers:

| Header                  | What it is                                                              |
| ----------------------- | ----------------------------------------------------------------------- |
| `Content-Type`          | `application/json`                                                      |
| `X-Fruitback-Delivery`  | The id of this delivery. It is the same at each attempt for one note.   |
| `X-Fruitback-Timestamp` | When this attempt was signed, in seconds since 1970.                    |
| `X-Fruitback-Signature` | `sha256=` and the signature of this attempt, in hexadecimal. See below. |

## Check the signature

The signature is the HMAC-SHA256, with your secret, of the timestamp, a dot and the body **as it
arrived**, byte for byte. Check it before you read the body:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function isFromFruitback(secret, headers, rawBody) {
  const timestamp = headers['x-fruitback-timestamp'];
  const expected = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
  const given = headers['x-fruitback-signature'] ?? '';
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;

  return fresh && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
```

- **Sign the bytes you received.** A body parsed and written again is not the same bytes.
- **Refuse an old timestamp.** Five minutes is enough. The timestamp is signed, so a copy of a
  request cannot be sent again later with a new time.
- **Compare in constant time.**

To try it by hand:

```bash
printf '1760000000.{"version":1}' | openssl dgst -sha256 -hmac 'a-secret-of-enough-length'
# a73ee69fbd433aae0f6bf90c540f89584463d5c2ee12643fc69c36fd7195c38c
```

## Answer, and what happens when you do not

Answer any `2xx` when the note is yours. The body of your answer is not read.

Anything else is a delivery that did not arrive: another status, a redirect (it is not followed), no
answer in 10 seconds. Fruitback then tries again after 1 minute, 5 minutes, 30 minutes, 2 hours,
6 hours and 24 hours: seven attempts in about a day and a half. After the last one it stops, and the
delivery waits for somebody to ask again. Asking starts the seven attempts again. A delivery nobody asks for is removed after
30 days.

**One note can arrive twice.** Your answer can be lost on the way back, and the next attempt then
sends the note again. `X-Fruitback-Delivery` is the same for both: keep the ids you took, and answer
`2xx` to one you already have.

The first attempt usually leaves within about 15 seconds of the note. The reporter does not wait for it: the
widget is answered when Fruitback keeps the note.

## The address and the secret

- The address is `https://`, with no name and password in it. Fruitback does not call its own host,
  a private network or `localhost`, and it checks that when the name is resolved, at each attempt.
- The secret is 16 to 256 characters with no space. Give none and Fruitback makes one, and shows it
  **once**. Fruitback keeps the address and the secret encrypted, and answers neither again.
- To change the address or the secret, disconnect the connector and connect a new one. The
  deliveries that waited go with the old one.
