import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SEED_STAGE,
  FRUITBACK_LABEL,
  SEED_BLOCK_CAPTION,
  SEED_STAGES,
  buildIssueDescription,
  buildIssueLabels,
  buildIssueTitle,
  pageQueryTerm,
  parseSeedFromDescription,
} from './linear.ts';
import { SEED_VERSION } from './seed.ts';
import { minimalSeedFixture, seedFixture } from './seed.fixture.ts';

/** Rebuild the description the way Linear or a human might have left it. */
function withSeedBlock(block: string): string {
  return `Some human prose above.\n\n${SEED_BLOCK_CAPTION}\n\n${block}\n`;
}

function parsedSeed(description: string) {
  const result = parseSeedFromDescription(description);
  if (!result.ok) throw new assert.AssertionError({ message: `expected a seed, got ${result.reason}` });

  return result.seed;
}

describe('buildIssueDescription', () => {
  it('round-trips a full seed', () => {
    const seed = seedFixture();

    assert.deepEqual(parsedSeed(buildIssueDescription(seed)), seed);
  });

  it('round-trips a seed with no optional field set', () => {
    const seed = minimalSeedFixture();

    assert.deepEqual(parsedSeed(buildIssueDescription(seed)), seed);
  });

  it('keeps the note readable above the payload', () => {
    const seed = seedFixture();
    const description = buildIssueDescription(seed);

    assert.ok(description.indexOf(seed.note) < description.indexOf(SEED_BLOCK_CAPTION));
    assert.ok(description.includes('**Component** · `CheckoutCta` — `src/components/checkout-cta.tsx:42`'));
    assert.ok(description.includes('**Viewport** · 1440×900 @2×'));
    assert.ok(description.includes('**Reported by** · Anonymous'));
  });

  it('writes the canonical page URL verbatim, so Linear can filter on it', () => {
    // This is what makes `description: { contains: … }` a usable server-side query for a page.
    const description = buildIssueDescription(seedFixture());
    const term = pageQueryTerm('https://preview.acme.test/pricing/?utm_source=x&tab=annual#cta');

    assert.ok(description.includes(term), `expected the description to contain ${term}`);
  });
});

describe('parseSeedFromDescription', () => {
  const seed = seedFixture();
  const payload = JSON.stringify(seed, null, 2);

  it('finds the seed when the language tag is gone', () => {
    assert.deepEqual(parsedSeed(withSeedBlock(`\`\`\`\n${payload}\n\`\`\``)), seed);
  });

  it('finds the seed in a tilde fence', () => {
    assert.deepEqual(parsedSeed(withSeedBlock(`~~~json\n${payload}\n~~~`)), seed);
  });

  it('finds the seed in a longer fence', () => {
    assert.deepEqual(parsedSeed(withSeedBlock(`\`\`\`\`json\n${payload}\n\`\`\`\``)), seed);
  });

  it('survives CRLF line endings', () => {
    assert.deepEqual(parsedSeed(withSeedBlock(`\`\`\`json\n${payload}\n\`\`\``).replace(/\n/g, '\r\n')), seed);
  });

  it('survives an unterminated fence', () => {
    assert.deepEqual(parsedSeed(`${SEED_BLOCK_CAPTION}\n\n\`\`\`json\n${payload}`), seed);
  });

  it('survives a human replying underneath', () => {
    const edited = `${buildIssueDescription(seed)}\n---\n\nFixed in the next deploy — can you confirm?\n`;

    assert.deepEqual(parsedSeed(edited), seed);
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
      buildIssueDescription(seed),
    ].join('\n\n');

    assert.deepEqual(parsedSeed(description), seed);
  });

  it('reports not-found on an issue nobody planted', () => {
    assert.deepEqual(parseSeedFromDescription('Just a regular ticket.'), { ok: false, reason: 'not-found' });
    assert.deepEqual(parseSeedFromDescription(''), { ok: false, reason: 'not-found' });
    assert.deepEqual(parseSeedFromDescription(null), { ok: false, reason: 'not-found' });
  });

  it('reports not-found when the JSON itself was mangled', () => {
    const mangled = withSeedBlock(`\`\`\`json\n${payload.slice(0, 120)}\n\`\`\``);

    assert.deepEqual(parseSeedFromDescription(mangled), { ok: false, reason: 'not-found' });
  });

  it('surfaces a newer payload instead of pretending there is none', () => {
    const newer = JSON.stringify({ ...seed, v: SEED_VERSION + 1 }, null, 2);

    assert.deepEqual(parseSeedFromDescription(withSeedBlock(`\`\`\`json\n${newer}\n\`\`\``)), {
      ok: false,
      reason: 'unsupported-version',
      version: SEED_VERSION + 1,
    });
  });
});

describe('buildIssueTitle', () => {
  it('uses the first line the visitor wrote', () => {
    const seed = seedFixture({ note: '  \n  Le CTA est trop petit\n\nEt le contraste est faible.' });

    assert.equal(buildIssueTitle(seed), 'Le CTA est trop petit');
  });

  it('truncates on a word boundary', () => {
    const seed = seedFixture({
      note: 'Le bouton de commande est vraiment beaucoup trop petit sur les écrans de téléphone',
    });

    const title = buildIssueTitle(seed, { maxLength: 40 });

    assert.equal(title, 'Le bouton de commande est vraiment…');
    assert.ok(title.length <= 40);
  });

  it('falls back to the element when the note is empty', () => {
    const seed = minimalSeedFixture();

    assert.equal(buildIssueTitle(seed), 'Feedback on <h1> — /');
  });
});

describe('labels', () => {
  it('tags every issue, and the client when there is one', () => {
    assert.deepEqual(buildIssueLabels(seedFixture()), [FRUITBACK_LABEL, 'fruitback:acme']);
    assert.deepEqual(buildIssueLabels(minimalSeedFixture()), [FRUITBACK_LABEL]);
  });
});

describe('the stage vocabulary', () => {
  // The projection from a provider's own states lives with its connector since SKG-516 — this
  // package is installed by every consumer of the widget, and a `LinearStateType` here made all of
  // them depend on Linear. `apps/worker/src/linear.test.ts` owns that mapping's tests now. What is
  // still the contract's is the vocabulary itself and the fallback every connector uses.
  it('is the five stages the widget draws, in ripening order', () => {
    assert.deepEqual([...SEED_STAGES], ['seeded', 'green', 'ripening', 'ripe', 'composted']);
  });

  it('falls back to a stage that exists', () => {
    assert.ok(SEED_STAGES.includes(DEFAULT_SEED_STAGE));
  });
});

describe('whose word the attribution is', () => {
  it('marks a self-declared name as the claim it is', () => {
    const description = buildIssueDescription(seedFixture({ reporter: { name: 'Alice', email: 'alice@acme.test' } }));

    assert.match(description, /\*\*Reported by\*\* · Alice · alice@acme\.test \(unverified — self-declared\)/);
  });

  it('marks a verified identity as verified', () => {
    const description = buildIssueDescription(
      seedFixture({ reporter: { name: 'Alice', email: 'alice@acme.test', verified: true } }),
    );

    assert.match(description, /\*\*Reported by\*\* · Alice · alice@acme\.test \(verified\)/);
  });

  it('says Anonymous when nobody said who they were', () => {
    assert.match(buildIssueDescription(seedFixture({ reporter: undefined })), /\*\*Reported by\*\* · Anonymous/);
  });

  it('round-trips a verified reporter', () => {
    // The invariant the whole contract rests on, applied to the new field.
    const seed = seedFixture({ reporter: { name: 'Alice', verified: true } });
    const parsed = parseSeedFromDescription(buildIssueDescription(seed));

    assert.ok(parsed.ok);
    assert.deepEqual(parsed.seed, seed);
  });
});

describe('a verified reporter with no name', () => {
  it('is identified by its id rather than read as anonymous', () => {
    // A token carrying only `sub` identifies someone; it just does not name them. Calling that
    // "Anonymous" throws away the distinction the line exists to make.
    const description = buildIssueDescription(seedFixture({ reporter: { id: 'user_42', verified: true } }));

    assert.match(description, /\*\*Reported by\*\* · user_42 \(verified\)/);
  });

  it('is still anonymous when the reporter said nothing at all', () => {
    assert.match(buildIssueDescription(seedFixture({ reporter: undefined })), /\*\*Reported by\*\* · Anonymous/);
  });
});
