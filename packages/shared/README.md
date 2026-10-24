# @fruitback/shared

The contract of [Fruitback](https://fruitback.com): the shape of a note that the widget
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
import { parseNote } from '@fruitback/shared';

// The body of a request of the REST connector carries the note in `seed`.
const parsed = parseNote(JSON.parse(body).seed);
if (parsed.ok) {
  console.log(parsed.note.note, parsed.note.page.url, parsed.note.anchor.selector);
}
```

`parseNote` never throws: a value that is not a valid note gives `{ ok: false, reason }`. The types
(`Note`, `NoteAnchor`, `NotePage`, …) come with the schemas.

A note was called a _seed_ until 0.4.0. The names of before (`parseSeed`, `Seed`, `seedSchema`,
`@fruitback/shared/seed.fixture`, …) still work, marked deprecated, and go in a later version. An
issue written before then holds `"kind": "fruitback.seed"`, and `parseNote` reads it for good.

## Guides

- [Receiving notes on your own address](https://fruitback.com/rest-connector.html): the request
  for each note, and its signature.
- [What the widget collects](https://fruitback.com/privacy.html): every field of a note.
- [Architecture](https://fruitback.com/architecture.html): the note contract, and why it is a
  package of its own.

## Licence

MIT. The source is in the [Fruitback repository](https://github.com/sakuga-software/fruitback).
