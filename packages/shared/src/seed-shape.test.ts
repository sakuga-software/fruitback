import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { SEED_VERSION, seedSchema } from './seed.ts';

/**
 * The shape of the payload, written down beside the version it belongs to.
 *
 * The rule is « bump `SEED_VERSION` when the payload shape changes ». Nothing held it: a field added
 * to `seedSchema` passed every test, and a reader of the version before then met a payload it could
 * not tell from its own. This test cannot decide for somebody whether a change needs a new version.
 * It makes the change impossible to miss: the shape is recorded here, so a change to the schema
 * fails until somebody edits this file, and the message says what to decide.
 *
 * The shape is read from the schema, never from a seed: a fixture holds the fields its writer
 * thought of.
 */

const RECORDED = {
  version: 2,
  shape: [
    'kind: string',
    'v: integer',
    'id: string',
    'createdAt: string',
    'note: string',
    'page.url: string',
    'page.path: string',
    'page.title?: string',
    'viewport.width: number',
    'viewport.height: number',
    'viewport.dpr?: number',
    'anchor.selector: string',
    'anchor.domPath?: string',
    'anchor.tag: string',
    'anchor.text?: string',
    'anchor.attrs?.id?: string',
    'anchor.attrs?.testId?: string',
    'anchor.attrs?.name?: string',
    'anchor.attrs?.role?: string',
    'anchor.attrs?.ariaLabel?: string',
    'anchor.bounds.xPct: number',
    'anchor.bounds.yPct: number',
    'anchor.bounds.wPct: number',
    'anchor.bounds.hPct: number',
    'source?.component?: string',
    'source?.file?: string',
    'source?.line?: number',
    'source?.column?: number',
    'client?.id: string',
    'client?.name?: string',
    'reporter?.id?: string',
    'reporter?.name?: string',
    'reporter?.email?: string',
    'reporter?.verified?: boolean',
    'env?.userAgent?: string',
    'env?.locale?: string',
    'env?.platform?: string',
    'screenshot?.url?: string',
    'screenshot?.width?: number',
    'screenshot?.height?: number',
  ],
};

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
};

/** One line for each leaf of a schema: its path, a `?` after each optional step, and its type. */
export function shapeOf(schema: JsonSchema, path = ''): string[] {
  if (schema.type === 'object' && schema.properties !== undefined) {
    const required = schema.required ?? [];

    return Object.entries(schema.properties).flatMap(([key, value]) => {
      const step = `${path === '' ? '' : `${path}.`}${key}${required.includes(key) ? '' : '?'}`;

      return shapeOf(value, step);
    });
  }
  if (schema.type === 'array' && schema.items !== undefined) return shapeOf(schema.items, `${path}[]`);

  return [`${path}: ${schema.type ?? 'unknown'}`];
}

describe('the shape of a seed, beside its version', () => {
  const shape = shapeOf(z.toJSONSchema(seedSchema) as JsonSchema);

  it('is the shape recorded for this version', () => {
    assert.deepEqual(
      shape,
      RECORDED.shape,
      'the payload shape changed. Decide: if a reader of the version before would misread the new payload, ' +
        'bump SEED_VERSION. Then record the new shape, and the version, in this file.',
    );
  });

  it('is recorded for the version the code writes', () => {
    assert.equal(SEED_VERSION, RECORDED.version, 'SEED_VERSION moved: record it here, with the shape it now names');
  });

  /** A guard over an empty set passes. */
  it('reads the fields of the schema, optional ones included', () => {
    assert.ok(shape.length >= 30, `only ${shape.length} fields were read from the schema`);
    assert.ok(shape.includes('note: string'));
    assert.ok(shape.some((line) => line.startsWith('source?.')));
  });
});
