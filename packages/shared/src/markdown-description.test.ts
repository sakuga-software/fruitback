import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOTE_BLOCK_CAPTION,
  TEAM_WORDS,
  buildIssueDescription,
  buildIssueMetadata,
  buildIssueTitle,
  buildNoteBlock,
  pageQueryTerm,
  parseNoteFromDescription,
  teamWords,
} from './markdown-description.ts';
import { NOTE_KIND, NOTE_VERSION, SEED_VERSION, type NoteSource } from './note.ts';
import { minimalNoteFixture, noteFixture } from './note.fixture.ts';

/** Rebuild the description the way a tracker's editor or a human might have left it. */
function withNoteBlock(block: string): string {
  return `Some human prose above.\n\n${NOTE_BLOCK_CAPTION}\n\n${block}\n`;
}

function parsedNote(description: string) {
  const result = parseNoteFromDescription(description);
  if (!result.ok) throw new assert.AssertionError({ message: `expected a note, got ${result.reason}` });

  return result.note;
}

describe('buildIssueDescription', () => {
  it('round-trips a full note', () => {
    const note = noteFixture();

    assert.deepEqual(parsedNote(buildIssueDescription(note)), note);
  });

  it('round-trips a note with no optional field set', () => {
    const note = minimalNoteFixture();

    assert.deepEqual(parsedNote(buildIssueDescription(note)), note);
  });

  it('keeps the note readable above the payload', () => {
    const note = noteFixture();
    const description = buildIssueDescription(note);

    assert.ok(description.indexOf(note.note) < description.indexOf(NOTE_BLOCK_CAPTION));
    assert.ok(description.includes('**Component** · `CheckoutCta` — `src/components/checkout-cta.tsx:42`'));
    assert.ok(description.includes('**Viewport** · 1440×900 @2×'));
    assert.ok(description.includes('**Reported by** · Anonymous'));
  });

  it('writes the canonical page URL verbatim, so Linear can filter on it', () => {
    // This is what makes `description: { contains: … }` a usable server-side query for a page.
    const description = buildIssueDescription(noteFixture());
    const term = pageQueryTerm('https://preview.acme.test/pricing/?utm_source=x&tab=annual#cta');

    assert.ok(description.includes(term), `expected the description to contain ${term}`);
  });
});

describe('parseNoteFromDescription', () => {
  const note = noteFixture();
  const payload = JSON.stringify(note, null, 2);

  it('finds the note when the language tag is gone', () => {
    assert.deepEqual(parsedNote(withNoteBlock(`\`\`\`\n${payload}\n\`\`\``)), note);
  });

  it('finds the note in a tilde fence', () => {
    assert.deepEqual(parsedNote(withNoteBlock(`~~~json\n${payload}\n~~~`)), note);
  });

  it('finds the note in a longer fence', () => {
    assert.deepEqual(parsedNote(withNoteBlock(`\`\`\`\`json\n${payload}\n\`\`\`\``)), note);
  });

  it('survives CRLF line endings', () => {
    assert.deepEqual(parsedNote(withNoteBlock(`\`\`\`json\n${payload}\n\`\`\``).replace(/\n/g, '\r\n')), note);
  });

  it('survives an unterminated fence', () => {
    assert.deepEqual(parsedNote(`${NOTE_BLOCK_CAPTION}\n\n\`\`\`json\n${payload}`), note);
  });

  it('finds the block by its JSON, never by the caption above it (FRU-24)', () => {
    // `NOTE_BLOCK_CAPTION` is written into every issue description, so whether it is load-bearing
    // decides whether it can ever be reworded. It is not: `parseNoteFromDescription` iterates fenced
    // blocks and recognises ours by parsing the JSON. Asserted rather than read, because "the parser
    // does not use it" is exactly the kind of claim that ages badly — and FRU-24 needed it true
    // before dropping the emoji the caption used to open with.
    const block = ['```json', payload, '```'].join('\n');

    assert.deepEqual(parsedNote(`Une prose quelconque\n\n${block}`), note, 'no caption at all');
    assert.deepEqual(parsedNote(`## Something else entirely\n\n${block}`), note, 'a different caption');
    assert.deepEqual(parsedNote(block), note, 'nothing above it');
  });

  it('survives a human replying underneath', () => {
    const edited = `${buildIssueDescription(note)}\n---\n\nFixed in the next deploy — can you confirm?\n`;

    assert.deepEqual(parsedNote(edited), note);
  });

  it('skips unrelated code blocks', () => {
    const description = [
      'Repro steps:',
      '```bash',
      'pnpm dev',
      '```',
      '```json',
      '{ "unrelated": true }',
      '```',
      buildIssueDescription(note),
    ].join('\n\n');

    assert.deepEqual(parsedNote(description), note);
  });

  it('reports not-found on an issue nobody planted', () => {
    assert.deepEqual(parseNoteFromDescription('Just a regular ticket.'), { ok: false, reason: 'not-found' });
    assert.deepEqual(parseNoteFromDescription(''), { ok: false, reason: 'not-found' });
    assert.deepEqual(parseNoteFromDescription(null), { ok: false, reason: 'not-found' });
  });

  it('reports not-found when the JSON itself was mangled', () => {
    const mangled = withNoteBlock(`\`\`\`json\n${payload.slice(0, 120)}\n\`\`\``);

    assert.deepEqual(parseNoteFromDescription(mangled), { ok: false, reason: 'not-found' });
  });

  it('surfaces a newer payload instead of pretending there is none', () => {
    const newer = JSON.stringify({ ...note, v: SEED_VERSION + 1 }, null, 2);

    assert.deepEqual(parseNoteFromDescription(withNoteBlock(`\`\`\`json\n${newer}\n\`\`\``)), {
      ok: false,
      reason: 'unsupported-version',
      version: SEED_VERSION + 1,
    });
  });
});

describe('parseNoteFromDescription, both kinds (FRU-378)', () => {
  const note = noteFixture();
  const { kind: _kind, v: _v, note: text, ...rest } = note;
  const version3 = JSON.stringify({ kind: NOTE_KIND, v: NOTE_VERSION, ...rest, text }, null, 2);

  it('reads an issue written with fruitback.seed, as every issue already in a tracker is', () => {
    assert.equal(JSON.parse(buildNoteBlock(note).split('\n').slice(1, -1).join('\n')).kind, 'fruitback.seed');
    assert.deepEqual(parseNoteFromDescription(buildIssueDescription(note)), { ok: true, note });
  });

  it('reads an issue written with fruitback.note as the same note', () => {
    assert.deepEqual(parseNoteFromDescription(withNoteBlock(`\`\`\`json\n${version3}\n\`\`\``)), { ok: true, note });
  });

  it('writes a note it read from fruitback.note back as the issue of fruitback.seed', () => {
    const read = parsedNote(withNoteBlock(`\`\`\`json\n${version3}\n\`\`\``));

    assert.equal(buildIssueDescription(read), buildIssueDescription(note));
  });
});

describe('buildIssueTitle', () => {
  it('uses the first line the visitor wrote', () => {
    const note = noteFixture({ note: '  \n  Le CTA est trop petit\n\nEt le contraste est faible.' });

    assert.equal(buildIssueTitle(note), 'Le CTA est trop petit');
  });

  it('truncates on a word boundary', () => {
    const note = noteFixture({
      note: 'Le bouton de commande est vraiment beaucoup trop petit sur les écrans de téléphone',
    });

    const title = buildIssueTitle(note, { maxLength: 40 });

    assert.equal(title, 'Le bouton de commande est vraiment…');
    assert.ok(title.length <= 40);
  });

  it('falls back to the element when the note is empty', () => {
    const note = minimalNoteFixture();

    assert.equal(buildIssueTitle(note), 'Feedback on <h1> — /');
  });
});

describe('the bounds of a cut title', () => {
  it('keeps a title of exactly the limit whole, and cuts one character more', () => {
    const note = noteFixture({ note: 'abcdefghij' });

    assert.equal(buildIssueTitle(note, { maxLength: 10 }), 'abcdefghij');
    assert.equal(buildIssueTitle(noteFixture({ note: 'abcdefghijk' }), { maxLength: 10 }), 'abcdefghi…');
  });

  it('breaks on the last space only when it lies past 60 % of the limit', () => {
    // With a limit of 10, the space must sit after index 6. At index 6, breaking there would eat
    // too much of the title, so the cut is hard.
    assert.equal(buildIssueTitle(noteFixture({ note: 'abcdefg hijklmnop' }), { maxLength: 10 }), 'abcdefg…');
    assert.equal(buildIssueTitle(noteFixture({ note: 'abcdef ghijklmnop' }), { maxLength: 10 }), 'abcdef gh…');
  });

  it('cuts at 80 characters by default', () => {
    const title = buildIssueTitle(noteFixture({ note: 'x'.repeat(200) }));

    assert.equal(title, `${'x'.repeat(79)}…`);
  });
});

describe('the lines of a description that a member reads', () => {
  it('names the client by its name, by its id when it has no name, and not at all when there is none', () => {
    assert.ok(buildIssueMetadata(noteFixture()).includes('**Client** · Acme'));
    assert.ok(buildIssueMetadata(noteFixture({ client: { id: 'acme' } })).includes('**Client** · acme'));
    assert.equal(
      buildIssueMetadata(minimalNoteFixture()).some((line) => line.startsWith('**Client**')),
      false,
    );
  });

  it('writes the component and the file, each without the other', () => {
    const componentLine = (source: NoteSource | undefined) =>
      buildIssueMetadata(noteFixture({ source })).find((line) => line.startsWith('**Component**'));

    assert.equal(
      componentLine({ component: 'CheckoutCta', file: 'src/checkout-cta.tsx', line: 42 }),
      '**Component** · `CheckoutCta` — `src/checkout-cta.tsx:42`',
    );
    assert.equal(componentLine({ component: 'CheckoutCta' }), '**Component** · `CheckoutCta`');
    assert.equal(componentLine({ file: 'src/checkout-cta.tsx' }), '**Component** · `src/checkout-cta.tsx`');
    assert.equal(
      componentLine({ file: 'src/checkout-cta.tsx', line: 42 }),
      '**Component** · `src/checkout-cta.tsx:42`',
    );
    assert.equal(componentLine({ line: 42, column: 7 }), undefined);
    assert.equal(componentLine(undefined), undefined);
  });

  it('writes the pixel ratio only when it is neither absent nor 1', () => {
    const viewportLine = (dpr: number | undefined) =>
      buildIssueMetadata(
        noteFixture({ viewport: { width: 1440, height: 900, ...(dpr === undefined ? {} : { dpr }) } }),
      ).find((line) => line.startsWith('**Viewport**'));

    assert.equal(viewportLine(2), '**Viewport** · 1440×900 @2×');
    assert.equal(viewportLine(1), '**Viewport** · 1440×900');
    assert.equal(viewportLine(undefined), '**Viewport** · 1440×900');
  });

  it('says Anonymous for a reporter whose fields are all empty', () => {
    for (const reporter of [{}, { id: '' }, { name: '', email: '' }]) {
      assert.ok(
        buildIssueMetadata(noteFixture({ reporter })).includes('**Reported by** · Anonymous'),
        JSON.stringify(reporter),
      );
    }
  });
});

describe('whose word the attribution is', () => {
  it('marks a self-declared name as the claim it is', () => {
    const description = buildIssueDescription(noteFixture({ reporter: { name: 'Alice', email: 'alice@acme.test' } }));

    assert.match(description, /\*\*Reported by\*\* · Alice · alice@acme\.test \(unverified — self-declared\)/);
  });

  it('marks a verified identity as verified', () => {
    const description = buildIssueDescription(
      noteFixture({ reporter: { name: 'Alice', email: 'alice@acme.test', verified: true } }),
    );

    assert.match(description, /\*\*Reported by\*\* · Alice · alice@acme\.test \(verified\)/);
  });

  it('says Anonymous when nobody said who they were', () => {
    assert.match(buildIssueDescription(noteFixture({ reporter: undefined })), /\*\*Reported by\*\* · Anonymous/);
  });

  it('round-trips a verified reporter', () => {
    // The invariant the whole contract rests on, applied to the new field.
    const note = noteFixture({ reporter: { name: 'Alice', verified: true } });
    const parsed = parseNoteFromDescription(buildIssueDescription(note));

    assert.ok(parsed.ok);
    assert.deepEqual(parsed.note, note);
  });
});

describe('a verified reporter with no name', () => {
  it('is identified by its id rather than read as anonymous', () => {
    // A token carrying only `sub` identifies someone; it just does not name them. Calling that
    // "Anonymous" throws away the distinction the line exists to make.
    const description = buildIssueDescription(noteFixture({ reporter: { id: 'user_42', verified: true } }));

    assert.match(description, /\*\*Reported by\*\* · user_42 \(verified\)/);
  });

  it('is still anonymous when the reporter said nothing at all', () => {
    assert.match(buildIssueDescription(noteFixture({ reporter: undefined })), /\*\*Reported by\*\* · Anonymous/);
  });
});

/**
 * The words of the prose follow the team that triages, never the reporter's browser (FRU-39).
 *
 * The invariant comes first: the locale reaches the prose and never the JSON block, so the round
 * trip holds in every language. A translated key would break it in silence.
 */
describe('the language of a description (FRU-39)', () => {
  it('reads back the same note in every language it is written in', () => {
    const note = noteFixture();

    for (const locale of [undefined, 'en', 'fr', 'fr-CA', 'de']) {
      const description = buildIssueDescription(note, { locale });

      assert.deepEqual(parseNoteFromDescription(description), { ok: true, note }, `the round trip failed in ${locale}`);
    }
  });

  it('writes the prose in the team locale, and the caption with it', () => {
    const description = buildIssueDescription(noteFixture({ note: 'Le CTA est trop petit' }), { locale: 'fr' });

    assert.match(description, /\*\*Page\*\* · \[/);
    assert.match(description, /\*\*Élément\*\*/);
    assert.match(description, /\*\*Fenêtre\*\*/);
    assert.match(description, /\*\*Signalé par\*\*/);
    assert.match(description, /\*\*Données Fruitback\*\*/);
    assert.equal(description.includes('**Reported by**'), false);
  });

  it('never translates the note, nor the name the reporter typed', () => {
    const note = noteFixture({ note: 'The call to action is too small', reporter: { name: 'Alice Smith' } });

    const description = buildIssueDescription(note, { locale: 'fr' });

    assert.ok(description.includes('The call to action is too small'));
    assert.ok(description.includes('Alice Smith'));
    // What is translated is the worker's own word about that name.
    assert.match(description, /Alice Smith \(non vérifié — déclaré par la personne\)/);
  });

  it('answers a region with the words of its language, and an unknown language in English', () => {
    assert.equal(teamWords('fr-CA').reportedBy, 'Signalé par');
    assert.equal(teamWords('FR').reportedBy, 'Signalé par');
    // A tag this build has no words for costs the translation, never the description.
    assert.equal(teamWords('de').reportedBy, 'Reported by');
    assert.equal(teamWords(undefined).reportedBy, 'Reported by');
    assert.equal(teamWords('').reportedBy, 'Reported by');
  });

  /** Every language says the same things, or a description loses a line when it is translated. */
  it('says the same things in each language it carries', () => {
    const english = Object.keys(TEAM_WORDS.en ?? {}).sort();

    for (const [locale, words] of Object.entries(TEAM_WORDS)) {
      assert.deepEqual(Object.keys(words).sort(), english, `${locale} does not carry the same words`);
      for (const [key, value] of Object.entries(words)) {
        assert.ok(value.length > 0, `${locale}.${key} is empty`);
      }
    }
  });

  it('is the English caption that `NOTE_BLOCK_CAPTION` names', () => {
    assert.equal(NOTE_BLOCK_CAPTION, teamWords('en').caption);
  });
});

describe('the sections of a description, exactly (FRU-377)', () => {
  it('trims the note, joins the lines of the metadata, and leaves out an empty note', () => {
    const note = minimalNoteFixture({ note: '\n  Le bouton déborde.  \n' });
    const metadata = buildIssueMetadata(note).join('\n');
    const tail = `${metadata}\n\n${NOTE_BLOCK_CAPTION}\n\n${buildNoteBlock(note)}\n`;

    assert.equal(buildIssueDescription(note), `Le bouton déborde.\n\n${tail}`);
    assert.equal(
      buildIssueDescription({ ...note, note: '   ' }),
      tail.replace(buildNoteBlock(note), buildNoteBlock({ ...note, note: '   ' })),
    );
  });
});

describe('a title, word by word (FRU-377)', () => {
  it('makes one space of each run of white space in the note', () => {
    assert.equal(buildIssueTitle(minimalNoteFixture({ note: 'Le  bouton\t\tdéborde' })), 'Le bouton déborde');
  });

  it('leaves no space before the ellipsis when it cuts without a word break', () => {
    // The space at 3 is not past 60 % of 5, so the cut keeps it, and the end of the cut is trimmed.
    assert.equal(buildIssueTitle(minimalNoteFixture({ note: 'abc defg' }), { maxLength: 5 }), 'abc…');
  });
});

describe('the fences of a description (FRU-377)', () => {
  const note = noteFixture();
  const payload = JSON.stringify(note, null, 2);
  const noteBlock = ['```json', payload, '```'].join('\n');

  it('finds the note in a fence indented by up to three spaces', () => {
    assert.deepEqual(parsedNote(`  \`\`\`json\n${payload}\n   \`\`\``), note);
  });

  it('closes a fence on a run followed by spaces', () => {
    assert.deepEqual(parsedNote(`\`\`\`json\n${payload}\n\`\`\`   \n\nA reply.`), note);
  });

  it('closes a fence on a run of its own character only, as long as it at least', () => {
    // Each block above the note holds a run that must not close it. If it did, the rest of the
    // block would open a new one, and swallow the note.
    const shorter = ['````md', '```', '````'].join('\n');
    const other = ['~~~', '```', '~~~'].join('\n');
    const withInfo = ['```', '```js', '```'].join('\n');

    for (const above of [shorter, other, withInfo]) {
      assert.deepEqual(parsedNote(`${above}\n\n${noteBlock}`), note, above);
    }
  });

  it('opens a fence only at the start of a line', () => {
    assert.deepEqual(parsedNote(`Quote code with \`\`\` around it.\n\n${noteBlock}`), note);
  });

  it('survives the old Mac line ending, a carriage return alone', () => {
    assert.deepEqual(parsedNote(withNoteBlock(noteBlock).replace(/\n/g, '\r')), note);
  });

  it('survives a no-break space that an editor left in the block', () => {
    assert.deepEqual(parsedNote(['```json', '\u00a0', payload, '```'].join('\n')), note);
  });

  it('answers the first note it can read, whatever a later block holds', () => {
    const newer = ['```json', JSON.stringify({ ...note, v: SEED_VERSION + 1 }), '```'].join('\n');

    assert.deepEqual(parsedNote(`${noteBlock}\n\n${newer}`), note);
  });

  it('keeps a real failure over a later block that is not a note', () => {
    const newer = ['```json', JSON.stringify({ ...note, v: SEED_VERSION + 1 }), '```'].join('\n');
    const unrelated = ['```json', '{ "unrelated": true }', '```'].join('\n');

    assert.deepEqual(parseNoteFromDescription(`${newer}\n\n${unrelated}`), {
      ok: false,
      reason: 'unsupported-version',
      version: SEED_VERSION + 1,
    });
  });
});
