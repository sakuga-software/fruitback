import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTACHMENT_KINDS,
  ATTACHMENT_TRANSIT_DAYS,
  ATTACHMENT_TYPES,
  MAX_ATTACHMENTS_PER_NOTE,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_BYTES_PER_NOTE,
  OPAQUE_TYPE,
  attachmentKindOf,
  seedAttachmentSchema,
} from './attachments.ts';
import { seedIssueSchema } from './issue.ts';
import { seedFixture } from './seed.fixture.ts';

describe('the files of a note (FRU-331)', () => {
  it('reads the kind of a type, whatever its case and its parameters', () => {
    assert.equal(attachmentKindOf('image/png'), 'image');
    assert.equal(attachmentKindOf(' IMAGE/JPEG ; q=0.9'), 'image');
    assert.equal(attachmentKindOf('application/pdf'), 'pdf');
    assert.equal(attachmentKindOf('text/plain; charset=utf-8'), 'text');
    assert.equal(attachmentKindOf('application/json'), 'text');
    for (const other of ['text/html', 'image/svg+xml', 'application/zip', '', null, undefined]) {
      assert.equal(attachmentKindOf(other), 'file', String(other));
    }
    for (const kind of ['image', 'pdf', 'text'] as const) {
      for (const type of ATTACHMENT_TYPES[kind]) assert.equal(attachmentKindOf(type), kind, type);
    }
  });

  it('holds the limits it says, a limit for every kind', () => {
    assert.deepEqual([...ATTACHMENT_KINDS], ['image', 'pdf', 'text', 'file']);
    assert.deepEqual(MAX_ATTACHMENT_BYTES, {
      image: 10_485_760,
      pdf: 10_485_760,
      text: 2_097_152,
      file: 10_485_760,
    });
    assert.equal(MAX_ATTACHMENTS_PER_NOTE, 5);
    assert.equal(MAX_ATTACHMENT_BYTES_PER_NOTE, 26_214_400);
    assert.equal(ATTACHMENT_TRANSIT_DAYS, 7);
    assert.equal(OPAQUE_TYPE, 'application/octet-stream');
    // No kind takes a type that a browser runs as a page.
    for (const types of Object.values(ATTACHMENT_TYPES)) {
      assert.equal(
        types.some((type) => type.includes('html') || type.includes('svg') || type.includes('javascript')),
        false,
      );
    }
  });

  it('reads the files of an issue as a name and the address of the tracker, and nothing else', () => {
    assert.deepEqual(seedAttachmentSchema.parse({ name: 'a.png', url: 'https://t.test/a' }), {
      name: 'a.png',
      url: 'https://t.test/a',
    });
    assert.deepEqual(seedAttachmentSchema.parse({ name: 'a.png' }), { name: 'a.png' });
    assert.equal(seedAttachmentSchema.safeParse({ name: '' }).success, false);
    assert.equal(seedAttachmentSchema.safeParse({ name: 'a.png', url: '' }).success, false);

    const issue = {
      id: 'i',
      identifier: 'X-1',
      title: 't',
      stage: 'seeded',
      stateName: '',
      updatedAt: '',
      attachments: [{ name: 'a.png' }],
      seed: seedFixture(),
    };
    assert.deepEqual(seedIssueSchema.parse(issue).attachments, [{ name: 'a.png' }]);
    const { attachments: _none, ...without } = issue;
    assert.equal('attachments' in seedIssueSchema.parse(without), false, 'absent stays absent');
  });
});
