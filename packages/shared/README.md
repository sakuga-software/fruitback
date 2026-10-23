# @fruitback/shared

The contract of [Fruitback](https://fruitback.com): the shape of a note (a _seed_) that the widget
writes and the server stores, with its schema, and the format of the issue description that carries
it.

You do not need this package to put the widget on a site: install
[`fruitback`](https://www.npmjs.com/package/fruitback), which re-exports it. Install it to read or
check notes in your own code, for example behind a
[REST connector](https://fruitback.com/rest-connector.html).

## Install

```bash
npm i @fruitback/shared
```

## Usage

```ts
import { parseSeed } from '@fruitback/shared';

// The body of a request of the REST connector carries the note in `seed`.
const parsed = parseSeed(JSON.parse(body).seed);
if (parsed.ok) {
  console.log(parsed.seed.note, parsed.seed.page.url, parsed.seed.anchor.selector);
}
```

`parseSeed` never throws: a value that is not a valid seed gives `{ ok: false, reason }`. The types
(`Seed`, `SeedAnchor`, `SeedPage`, …) come with the schemas.

## Guides

- [Receiving notes on your own address](https://fruitback.com/rest-connector.html): the request
  for each note, and its signature.
- [What the widget collects](https://fruitback.com/privacy.html): every field of a seed.
- [Architecture](https://fruitback.com/architecture.html): the seed contract, and why it is a
  package of its own.

## Licence

MIT. The source is in the [Fruitback repository](https://github.com/sakuga-software/fruitback).
