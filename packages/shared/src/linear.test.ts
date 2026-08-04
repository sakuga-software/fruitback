import { describe, expect, it } from 'vitest';
import {
  FRUITBACK_LABEL,
  SEED_BLOCK_CAPTION,
  buildIssueDescription,
  buildIssueLabels,
  buildIssueTitle,
  pageQueryTerm,
  parseSeedFromDescription,
  stageForLinearState,
} from './linear';
import { SEED_VERSION } from './seed';
import { minimalSeedFixture, seedFixture } from './seed.fixture';

/** Rebuild the description the way Linear or a human might have left it. */
function withSeedBlock(block: string): string {
  return `Some human prose above.\n\n${SEED_BLOCK_CAPTION}\n\n${block}\n`;
}

function expectSeed(description: string) {
  const result = parseSeedFromDescription(description);
  if (!result.ok) throw new Error(`expected a seed, got ${result.reason}`);

  return result.seed;
}

describe('buildIssueDescription', () => {
  it('round-trips a full seed', () => {
    const seed = seedFixture();

    expect(expectSeed(buildIssueDescription(seed))).toEqual(seed);
  });

  it('round-trips a seed with no optional field set', () => {
    const seed = minimalSeedFixture();

    expect(expectSeed(buildIssueDescription(seed))).toEqual(seed);
  });

  it('keeps the note readable above the payload', () => {
    const seed = seedFixture();
    const description = buildIssueDescription(seed);

    expect(description.indexOf(seed.note)).toBeLessThan(description.indexOf(SEED_BLOCK_CAPTION));
    expect(description).toContain('**Component** · `CheckoutCta` — `src/components/checkout-cta.tsx:42`');
    expect(description).toContain('**Viewport** · 1440×900 @2×');
    expect(description).toContain('**Reported by** · Anonymous');
  });

  it('writes the canonical page URL verbatim, so Linear can filter on it', () => {
    // This is what makes `description: { contains: … }` a usable server-side query for a page.
    const description = buildIssueDescription(seedFixture());

    expect(description).toContain(pageQueryTerm('https://preview.acme.test/pricing/?utm_source=x&tab=annual#cta'));
  });
});

describe('parseSeedFromDescription', () => {
  const seed = seedFixture();
  const payload = JSON.stringify(seed, null, 2);

  it('finds the seed when the language tag is gone', () => {
    expect(expectSeed(withSeedBlock(`\`\`\`\n${payload}\n\`\`\``))).toEqual(seed);
  });

  it('finds the seed in a tilde fence', () => {
    expect(expectSeed(withSeedBlock(`~~~json\n${payload}\n~~~`))).toEqual(seed);
  });

  it('finds the seed in a longer fence', () => {
    expect(expectSeed(withSeedBlock(`\`\`\`\`json\n${payload}\n\`\`\`\``))).toEqual(seed);
  });

  it('survives CRLF line endings', () => {
    expect(expectSeed(withSeedBlock(`\`\`\`json\n${payload}\n\`\`\``).replace(/\n/g, '\r\n'))).toEqual(seed);
  });

  it('survives an unterminated fence', () => {
    expect(expectSeed(`${SEED_BLOCK_CAPTION}\n\n\`\`\`json\n${payload}`)).toEqual(seed);
  });

  it('survives a human replying underneath', () => {
    const edited = `${buildIssueDescription(seed)}\n---\n\nFixed in the next deploy — can you confirm?\n`;

    expect(expectSeed(edited)).toEqual(seed);
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

    expect(expectSeed(description)).toEqual(seed);
  });

  it('reports not-found on an issue nobody planted', () => {
    expect(parseSeedFromDescription('Just a regular ticket.')).toEqual({ ok: false, reason: 'not-found' });
    expect(parseSeedFromDescription('')).toEqual({ ok: false, reason: 'not-found' });
    expect(parseSeedFromDescription(null)).toEqual({ ok: false, reason: 'not-found' });
  });

  it('reports not-found when the JSON itself was mangled', () => {
    expect(parseSeedFromDescription(withSeedBlock(`\`\`\`json\n${payload.slice(0, 120)}\n\`\`\``))).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('surfaces a newer payload instead of pretending there is none', () => {
    const newer = JSON.stringify({ ...seed, v: SEED_VERSION + 1 }, null, 2);

    expect(parseSeedFromDescription(withSeedBlock(`\`\`\`json\n${newer}\n\`\`\``))).toEqual({
      ok: false,
      reason: 'unsupported-version',
      version: SEED_VERSION + 1,
    });
  });
});

describe('buildIssueTitle', () => {
  it('uses the first line the visitor wrote', () => {
    const seed = seedFixture({ note: '  \n  Le CTA est trop petit\n\nEt le contraste est faible.' });

    expect(buildIssueTitle(seed)).toBe('Le CTA est trop petit');
  });

  it('truncates on a word boundary', () => {
    const seed = seedFixture({
      note: 'Le bouton de commande est vraiment beaucoup trop petit sur les écrans de téléphone',
    });

    const title = buildIssueTitle(seed, { maxLength: 40 });

    expect(title).toBe('Le bouton de commande est vraiment…');
    expect(title.length).toBeLessThanOrEqual(40);
  });

  it('falls back to the element when the note is empty', () => {
    const seed = minimalSeedFixture();

    expect(buildIssueTitle(seed)).toBe('Feedback on <h1> — /');
  });
});

describe('labels', () => {
  it('tags every issue, and the client when there is one', () => {
    expect(buildIssueLabels(seedFixture())).toEqual([FRUITBACK_LABEL, 'fruitback:acme']);
    expect(buildIssueLabels(minimalSeedFixture())).toEqual([FRUITBACK_LABEL]);
  });
});

describe('stageForLinearState', () => {
  it('ripens the pin along the Linear workflow', () => {
    expect(stageForLinearState('backlog')).toBe('seeded');
    expect(stageForLinearState('triage')).toBe('seeded');
    expect(stageForLinearState('unstarted')).toBe('green');
    expect(stageForLinearState('started')).toBe('ripening');
    expect(stageForLinearState('completed')).toBe('ripe');
    expect(stageForLinearState('canceled')).toBe('composted');
  });

  it('shows an unknown state as seeded rather than hiding the pin', () => {
    expect(stageForLinearState('someCustomType')).toBe('seeded');
  });
});
