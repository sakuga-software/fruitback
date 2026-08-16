import { type Seed, type SeedInput, createSeed } from './seed.ts';
import { type SeedIssue, seedIssueSchema } from './linear.ts';

/**
 * Shared through the `@fruitback/shared/seed.fixture` export so the worker and the widget test
 * against the same seed instead of each keeping its own drifting copy.
 */

/** A realistic seed, as the widget would build it on a preview deploy. */
export function seedFixture(overrides: Partial<SeedInput> = {}): Seed {
  return createSeed({
    id: 'sd_2f8c1a90',
    createdAt: '2026-08-04T09:15:00.000Z',
    note: 'Le bouton “Commander” est trop petit sur mobile, on le rate au pouce.',
    page: {
      url: 'https://preview.acme.test/pricing?tab=annual',
      path: '/pricing',
      title: 'Pricing — Acme',
    },
    viewport: { width: 1440, height: 900, dpr: 2 },
    anchor: {
      selector: '[data-testid="checkout-cta"]',
      domPath: 'html > body > div:nth-child(2) > main > section:nth-child(3) > button',
      tag: 'button',
      text: 'Commander',
      attrs: { testId: 'checkout-cta', role: 'button' },
      bounds: { xPct: 42.5, yPct: 61.25, wPct: 12, hPct: 4.5 },
    },
    source: { component: 'CheckoutCta', file: 'src/components/checkout-cta.tsx', line: 42, column: 7 },
    client: { id: 'acme', name: 'Acme' },
    env: { userAgent: 'Mozilla/5.0', locale: 'fr-FR', platform: 'macOS' },
    ...overrides,
  });
}

/** The other extreme: only what the schema requires, so round-trips are tested without optionals. */
export function minimalSeedFixture(overrides: Partial<SeedInput> = {}): Seed {
  return createSeed({
    id: 'sd_minimal',
    createdAt: '2026-08-04T09:15:00.000Z',
    note: '',
    page: { url: 'https://acme.test/', path: '/' },
    viewport: { width: 390, height: 844 },
    anchor: {
      selector: 'main > h1',
      tag: 'h1',
      bounds: { xPct: 0, yPct: 0, wPct: 100, hPct: 8 },
    },
    ...overrides,
  });
}

/**
 * A planted seed as the read path hands it back — the shape the overlay renders. Kept next to the
 * seed fixtures so the widget and the worker agree on it without either inventing its own.
 */
export function seedIssueFixture(overrides: Partial<SeedIssue> = {}): SeedIssue {
  return seedIssueSchema.parse({
    id: 'issue_1',
    identifier: 'SKG-901',
    url: 'https://linear.app/sakuga-software/issue/SKG-901',
    title: 'Le bouton est trop petit',
    stage: 'ripening',
    stateName: 'In Progress',
    updatedAt: '2026-08-05T10:00:00.000Z',
    seed: seedFixture(),
    ...overrides,
  });
}
