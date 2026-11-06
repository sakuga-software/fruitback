import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import * as icons from './popup-icons.ts';

const SET = new URL('../../../packages/widget/node_modules/@iconify-json/ph/icons.json', import.meta.url);

describe('the icons of screen 3 of the popup (FRU-599)', () => {
  it('are each a path of Phosphor, copied as it is', () => {
    const set = JSON.parse(readFileSync(SET, 'utf8')) as { icons: Record<string, { body: string }> };
    const source = readFileSync(new URL('./popup-icons.ts', import.meta.url), 'utf8');
    const named = [...source.matchAll(/`ph:([a-z-]+)`\s*\*\/\s*export const (\w+)/g)];
    assert.ok(named.length >= 8);
    for (const [, name, constant] of named) {
      const body = set.icons[name as string]?.body ?? '';
      assert.ok(
        body.includes(`d="${(icons as unknown as Record<string, string>)[constant as string]}"`),
        `${constant} is not ph:${name}`,
      );
    }
  });
});
