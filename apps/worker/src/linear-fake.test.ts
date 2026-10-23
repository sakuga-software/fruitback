import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, describe, it } from 'vitest';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import { createLinearStore } from './linear.ts';
import { LINEAR_FAKE_TEAM, createLinearFake, installLinearFake } from './linear-fake.fixture.ts';

/**
 * The fake Linear of the bench of the extension (FRU-426). The bench says « the tracker received
 * the files » from what this fake keeps, so the fake must keep what `linear.ts` really sends.
 */

const network = globalThis.fetch;
const POLICY = {
  showComments: true,
  identitySecret: undefined,
  read: 'public',
  write: 'public',
  locale: 'en',
} as const;
const config = { apiKey: 'lin_api_fake', teamId: LINEAR_FAKE_TEAM, projectId: undefined };

describe('the fake Linear of the bench (FRU-426)', () => {
  afterEach(() => {
    globalThis.fetch = network;
  });

  it('keeps the bytes of each file, the attachment, and gives the issue back to the read of its page', async () => {
    const fake = createLinearFake();
    installLinearFake(fake);
    const content = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const seed = seedFixture();
    const store = createLinearStore(config);

    await store.create(seed, undefined, POLICY, [{ id: 'att_1', name: 'area.png', type: 'image/png', content }]);

    const received = fake.received();
    assert.equal(received.issues.length, 1);
    assert.equal(received.issues[0]?.teamId, LINEAR_FAKE_TEAM);
    assert.deepEqual(
      received.puts.map(({ type, bytes, sha256 }) => ({ type, bytes, sha256 })),
      [{ type: 'image/png', bytes: content.byteLength, sha256: createHash('sha256').update(content).digest('hex') }],
    );
    assert.deepEqual(
      received.attachments.map(({ issueId, title }) => ({ issueId, title })),
      [{ issueId: received.issues[0]?.id, title: 'area.png' }],
    );

    const read = await store.findForPage({ url: seed.page.url, clientId: undefined }, undefined, POLICY);
    assert.equal(read.length, 1);
    assert.deepEqual(
      read[0]?.attachments?.map((file) => file.name),
      ['area.png'],
    );
  });

  it('leaves every request that is not for Linear to the network', () => {
    const fake = createLinearFake();
    assert.equal(fake.answer('https://example.test/graphql', { method: 'POST', body: '{}' }), undefined);
    assert.equal(fake.answer('https://storage.linear.fake/put/1', { method: 'GET' }), undefined);
  });
});
