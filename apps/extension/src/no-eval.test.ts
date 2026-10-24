import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { WITHOUT_EVAL, ZOD_EVAL, withoutEval } from './no-eval.ts';

/**
 * zod with no `Function` constructor in the build of the extension (FRU-389), against the zod of the
 * lockfile: the files are read where the build reads them.
 */

// The zod the shared package resolves: the one the build bundles.
const sharedRequire = createRequire(new URL('../../../packages/shared/package.json', import.meta.url));
const zodRoot = path.dirname(sharedRequire.resolve('zod'));
const UTIL = path.join(zodRoot, 'v4/core/util.js');
const DOC = path.join(zodRoot, 'v4/core/doc.js');

describe('zod without the Function constructor (FRU-389)', () => {
  it('takes it out of the two files that name it, and leaves no other word of it', () => {
    for (const file of [UTIL, DOC]) {
      const code = fs.readFileSync(file, 'utf8');
      assert.match(code, /\bFunction\b/, `${file} names the constructor no more: read src/no-eval.ts`);
      const built = withoutEval(code, file) as string;
      assert.ok(built.includes(WITHOUT_EVAL));
      assert.doesNotMatch(built, /\bFunction\s*[;(]/, file);
    }
  });

  it('makes the probe of zod answer that eval is refused, as the CSP of the extension does', async () => {
    const code = withoutEval(fs.readFileSync(UTIL, 'utf8'), UTIL) as string;
    // The probe alone, out of the file: it reads `globalConfig`, then tries `new F("")` in a `try`.
    const probe = /export const allowsEval = (?:\/\* @__PURE__\*\/ )?cached\(\(\) => \{([\s\S]*?)\n\}\);/.exec(
      code,
    )?.[1];
    assert.ok(probe !== undefined, 'the probe of zod moved: read src/no-eval.ts');
    // oxlint-disable-next-line no-new-func -- the probe of zod, run here as the build leaves it.
    assert.equal(new Function('globalConfig', probe)({ jitless: false }), false);
  });

  it('leaves every other file alone, and fails on a version of zod that writes the line otherwise', () => {
    assert.equal(withoutEval('const F = Function;', '/x/node_modules/zod/v4/core/schemas.js'), undefined);
    assert.equal(withoutEval('const F = Function;', '/x/packages/shared/src/seed.ts'), undefined);
    assert.throws(() => withoutEval('const Ctor = Function;', UTIL), /no longer writes/);
    assert.equal(ZOD_EVAL.length, 2);
  });
});
