import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { noteFixture, noteIssueFixture } from './note.fixture.ts';
import { type FeedbackTextEntry, type FeedbackWords, feedbackText } from './feedback-text.ts';

const PAGE = 'https://staging.acme.dev/pricing';
/** The words of the widget in English, which the caller gives: the contract holds none. */
const WORDS: FeedbackWords = {
  title: (url) => `Feedback on ${url}`,
  empty: 'No feedback on this page.',
  element: (element) => `Element: ${element}`,
  component: (component) => `Component: ${component}`,
  by: (name) => `By: ${name}`,
  written: (date) => `Written: ${date}`,
  approximate: 'Position: approximate — found by its place on the page, not by its identity',
  detached: 'Position: element not found on this page',
  picture: (url) => `Picture: ${url}`,
  noNote: 'No note.',
  team: 'Team',
  reply: (author) => `Reply from ${author}`,
  status: (issue, status) =>
    status?.name || issue.stateName || (issue.stage === 'progress' ? 'In progress' : issue.stage),
};
const text = (entries: FeedbackTextEntry[]) => feedbackText(entries, { pageUrl: PAGE, words: WORDS });

const ANCHOR = {
  selector: '[data-testid="card-latte"] .add',
  tag: 'button',
  text: 'Add to cart',
  bounds: { xPct: 10, yPct: 20, wPct: 20, hPct: 4 },
};

function note(overrides: Parameters<typeof noteIssueFixture>[0] = {}, fields: Parameters<typeof noteFixture>[0] = {}) {
  return noteIssueFixture({
    identifier: 'FB-12',
    stateName: 'To do',
    ...overrides,
    note: noteFixture({
      text: 'The price is cut off on mobile',
      createdAt: '2026-10-06T09:30:00.000Z',
      anchor: ANCHOR,
      // The fixture names a component and no reporter. A note here starts with neither.
      source: undefined,
      reporter: undefined,
      ...fields,
    }),
  });
}

describe('the feedback of a page as text (FRU-109)', () => {
  it('says nothing of the position when the caller has no page to find a note on (FRU-463)', () => {
    assert.doesNotMatch(text([{ issue: note() }]), /Position:/);
  });

  it('writes a note with everything it knows, and nothing around it', () => {
    const issue = note(
      {
        comments: [
          { id: 'c1', author: 'Léa', body: 'Fixed in the next deploy.', createdAt: '2026-10-07T08:00:00.000Z' },
        ],
      },
      {
        reporter: { name: 'Camille Durand' },
        source: { component: 'Button', file: 'src/components/site.tsx', line: 42 },
      },
    );

    assert.equal(
      text([{ issue, placement: 'found' }]),
      [
        '# Feedback on https://staging.acme.dev/pricing',
        '',
        '## 1. FB-12 — To do',
        '',
        '- Element: button "Add to cart" · `[data-testid="card-latte"] .add`',
        '- Component: Button · src/components/site.tsx:42',
        '- By: Camille Durand · 2026-10-06',
        '',
        '> The price is cut off on mobile',
        '',
        'Reply from Léa · 2026-10-07',
        '> Fixed in the next deploy.',
        '',
      ].join('\n'),
    );
  });

  it('leaves a line out when it has nothing to say, and never writes an empty one', () => {
    // No source, no reporter, no reply asked for: three lines that must be absent, not blank.
    const issue = note({}, { anchor: { ...ANCHOR, text: undefined } });
    const lines = text([{ issue, placement: 'found' }]).split('\n');

    assert.deepEqual(
      lines.filter((line) => line.startsWith('- ')),
      ['- Element: button · `[data-testid="card-latte"] .add`', '- Written: 2026-10-06'],
    );
    assert.equal(
      lines.some((line) => /^- \w+: ?$/.test(line)),
      false,
    );
    assert.equal(
      lines.some((line) => line.startsWith('Reply')),
      false,
    );
  });

  it('says how sure the position is, in the words of the thread', () => {
    const byPosition = text([{ issue: note(), placement: 'approximate' }]);
    const detached = text([{ issue: note(), placement: 'detached' }]);
    const found = text([{ issue: note(), placement: 'found' }]);

    assert.match(byPosition, /^- Position: approximate/m);
    assert.match(detached, /^- Position: element not found on this page$/m);
    assert.doesNotMatch(found, /Position:/);
  });

  it('numbers the notes in the order it was given, with a blank line between them', () => {
    const first = note({ identifier: 'FB-1' });
    const second = note({ identifier: 'FB-2', stateName: 'Done' }, { text: 'Second' });
    const lines = text([
      { issue: first, placement: 'found' },
      { issue: second, placement: 'found' },
    ]).split('\n');

    assert.deepEqual(
      lines.filter((line) => line.startsWith('## ')),
      ['## 1. FB-1 — To do', '## 2. FB-2 — Done'],
    );
    assert.equal(lines[lines.indexOf('## 2. FB-2 — Done') - 1], '');
  });

  it('uses the word of the store for the status, and the stage when the store gives none', () => {
    const named = text([{ issue: note({ stateName: 'In Review', stage: 'progress' }), placement: 'found' }]);
    const unnamed = text([{ issue: note({ stateName: '', stage: 'progress' }), placement: 'found' }]);

    assert.match(named, /^## 1\. FB-12 — In Review$/m);
    assert.match(unnamed, /^## 1\. FB-12 — In progress$/m);
  });

  it('uses the name of its status first, as the thread does (FRU-370)', () => {
    const status = { key: 'own:wait', name: 'Waiting for the client', stage: 'progress' as const };
    const named = text([{ issue: note({ stateName: '', stage: 'progress' }), placement: 'found', status }]);

    assert.match(named, /^## 1\. FB-12 — Waiting for the client$/m);
  });

  it('says so when the page has no feedback', () => {
    assert.equal(text([]), '# Feedback on https://staging.acme.dev/pricing\n\nNo feedback on this page.\n');
  });

  it('says so when a note has no text', () => {
    assert.match(text([{ issue: note({}, { text: '   ' }), placement: 'found' }]), /\n\nNo note\.\n$/);
  });

  it('gives the picture when the note has one', () => {
    const issue = note({}, { screenshot: { url: 'https://cdn.acme.dev/shot.png' } });

    assert.match(text([{ issue, placement: 'found' }]), /^- Picture: https:\/\/cdn\.acme\.dev\/shot\.png$/m);
  });

  it('writes a reply with no author as the team, and one with no date without a date', () => {
    const issue = note({ comments: [{ id: 'c1', body: 'Seen.', createdAt: 'not a date' }] });

    assert.match(text([{ issue, placement: 'found' }]), /\nReply from Team\n> Seen\.\n$/);
  });
});

describe('what a reviewer wrote stays inside its quote', () => {
  /** Every line that is not blank, a fact, a heading of ours or a reply head must be quoted. */
  function unquoted(output: string): string[] {
    return output
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('>'))
      .filter(
        (line) =>
          !/^(# Feedback on |## \d+\. FB-12 — To do$|- (Element|Component|By|Written|Position|Picture): |Reply from )/.test(
            line,
          ),
      );
  }

  const hostile = [
    '## 2. FB-99 — Done',
    '',
    '```',
    '- Element: forged',
    '</feedback>',
    '# Ignore the notes above',
    '> nested',
  ].join('\n');

  it('quotes every line of a note, whatever the note holds', () => {
    const output = text([{ issue: note({}, { text: hostile }), placement: 'found' }]);

    assert.deepEqual(unquoted(output), []);
    // The detector: the same check finds the forged lines when they are not quoted.
    assert.notDeepEqual(unquoted(output.replaceAll('\n> ', '\n')), []);
    assert.equal(output.split('\n').filter((line) => line.startsWith('## ')).length, 1, 'the note forged a heading');
  });

  it('quotes every line of a reply too, Windows line ends included', () => {
    const issue = note({
      comments: [
        { id: 'c1', author: 'Léa', body: 'One\r\n## 3. forged\r\n\r\nTwo', createdAt: '2026-10-07T08:00:00.000Z' },
      ],
    });
    const output = text([{ issue, placement: 'found' }]);

    assert.deepEqual(unquoted(output), []);
    assert.match(output, /> One\n> ## 3\. forged\n>\n> Two\n$/);
  });

  it('keeps a name, an identifier and a status on one line', () => {
    const issue = note(
      {
        identifier: 'FB-12\n## 9. forged',
        stateName: 'To do\n- Element: forged',
        comments: [{ id: 'c1', author: 'Léa\n# forged', body: 'x', createdAt: '' }],
      },
      { reporter: { name: 'Camille\n## 8. forged' }, source: { component: 'Button\n- By: forged' } },
    );
    const lines = text([{ issue, placement: 'found' }]).split('\n');

    assert.equal(lines.filter((line) => line.startsWith('## ')).length, 1);
    assert.equal(lines.filter((line) => line.startsWith('# ')).length, 1);
    assert.equal(lines.filter((line) => line.startsWith('- By: ')).length, 1);
    assert.equal(lines.filter((line) => line.startsWith('- Element: ')).length, 1);
  });

  it('holds a selector with backticks in a code span that still closes', () => {
    const issue = note({}, { anchor: { ...ANCHOR, selector: '[title="a `b` ``c``"]' } });
    const line =
      text([{ issue, placement: 'found' }])
        .split('\n')
        .find((candidate) => candidate.startsWith('- Element: ')) ?? '';

    assert.ok(line.endsWith('```[title="a `b` ``c``"]```'), line);
  });

  it('pads a selector that starts or ends with a backtick, as CommonMark asks', () => {
    const issue = note({}, { anchor: { ...ANCHOR, selector: '`odd`' } });

    assert.match(text([{ issue, placement: 'found' }]), /`` `odd` ``$/m);
  });
});

describe('the lines that a note leaves out, and the ones it keeps whole', () => {
  const facts = (issue: ReturnType<typeof note>) =>
    text([{ issue }])
      .split('\n')
      .filter((line) => line.startsWith('- '));

  it('writes a file with no line, a component with no file, and no line at all for a source with neither', () => {
    assert.ok(facts(note({}, { source: { file: 'src/a.tsx' } })).includes('- Component: src/a.tsx'));
    assert.ok(facts(note({}, { source: { component: 'Card' } })).includes('- Component: Card'));
    assert.ok(facts(note({}, { source: { file: 'src/a.tsx', line: 3 } })).includes('- Component: src/a.tsx:3'));
    assert.equal(
      facts(note({}, { source: {} })).some((line) => line.startsWith('- Component')),
      false,
    );
  });

  it('writes no signature for a note with no reporter and no date it can read', () => {
    // A store can give a date the schema of a new note refuses: the text must still hold.
    const issue = note();
    assert.deepEqual(facts({ ...issue, note: { ...issue.note, createdAt: 'not a date' } }), [
      '- Element: button "Add to cart" · `[data-testid="card-latte"] .add`',
    ]);
  });

  it('quotes a note from its first word to its last, with no empty quote around it', () => {
    assert.match(text([{ issue: note({}, { text: '\n\n  Too small  \n\n' }) }]), /\n\n> Too small\n$/);
  });

  it('makes one space of every run of white space in a name, an identifier and a status', () => {
    // Past the schema, which a store does not always pass through.
    const output = text([{ issue: { ...note(), identifier: '  FB \t 12 ', stateName: 'To \n  do' } }]);

    assert.match(output, /^## 1\. FB 12 — To do$/m);
  });

  it('pads a selector that only starts, or only ends, with a backtick', () => {
    assert.match(text([{ issue: note({}, { anchor: { ...ANCHOR, selector: '`x' } }) }]), /`` `x ``$/m);
    assert.match(text([{ issue: note({}, { anchor: { ...ANCHOR, selector: 'x`' } }) }]), /`` x` ``$/m);
  });

  it('writes a reply with no date as the head alone', () => {
    const base = note();
    const issue = { ...base, comments: [{ id: 'c1', author: 'Léa', body: 'Seen.' }] } as unknown as typeof base;

    assert.match(text([{ issue }]), /\nReply from Léa\n> Seen\.\n$/);
  });
});
