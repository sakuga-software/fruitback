import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LICENSE_IN_OUTPUT } from '../wxt.config.ts';

/**
 * The licence this extension is under, and the copy that travels with it (SKG-621).
 *
 * **What a store hands somebody is the archive, not this repository.** The AGPL asks for the licence
 * to go with the work, and the field in `package.json` is a claim the archive has to carry. The
 * field and the text are both checked, like the guard on the published packages: a file that exists
 * says nothing about what is in it.
 */

const EXTENSION = new URL('../', import.meta.url);

function read(path: string | URL): string {
  return readFileSync(path, 'utf8');
}

describe('the licence of the extension', () => {
  it('is the one the manifest claims, and the text of it', () => {
    const manifest = JSON.parse(read(new URL('package.json', EXTENSION))) as { license?: string };

    assert.equal(manifest.license, 'AGPL-3.0-only');
    const license = read(new URL('LICENSE', EXTENSION));
    assert.match(license, /GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/);
    // The same text as the worker's, which is under the same licence. Two copies that drift are two
    // licences, and the one the archive carries is this one.
    // Written from this file rather than from `EXTENSION`, because that is how `test-inputs.test.ts`
    // reads a path: against the file it is written in. The two have to agree, or the read is declared
    // as an input of nothing (SKG-610).
    assert.equal(license, read(new URL('../../worker/LICENSE', import.meta.url)));
  });

  /** A licence in the repository and not in the archive is the case this whole ticket is about. */
  it('is copied into the build, beside the manifest', () => {
    const config = read(new URL('wxt.config.ts', EXTENSION));

    assert.equal(LICENSE_IN_OUTPUT, 'LICENSE');
    assert.match(config, /'build:publicAssets'/);
    assert.match(config, /relativeDest: LICENSE_IN_OUTPUT/);
  });
});
