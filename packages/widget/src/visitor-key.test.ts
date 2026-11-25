import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TransportRequest } from './transport.ts';
import { VISITOR_HEADER, VISITOR_KEY_PREFIX, createVisitorKey } from './visitor-key.ts';
import { callWorker } from './worker-client.ts';

/** A `Storage` in memory, or one that refuses every call, as a sandbox does. */
function storage(refuses = false): Storage & { items: Map<string, string> } {
  const items = new Map<string, string>();
  const refuse = (): never => {
    throw new Error('SecurityError');
  };

  return {
    items,
    get length() {
      return items.size;
    },
    clear: () => (refuses ? refuse() : items.clear()),
    getItem: (key) => (refuses ? refuse() : (items.get(key) ?? null)),
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => (refuses ? refuse() : void items.delete(key)),
    setItem: (key, value) => (refuses ? refuse() : void items.set(key, value)),
  };
}

const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/u;

describe('the key of a browser for a site (FRU-700)', () => {
  it('has none before the first note, then makes one and keeps it under the id of the site', () => {
    const area = storage();
    const key = createVisitorKey(area, 'site_acme');

    assert.equal(key.current(), undefined);
    assert.equal(area.items.size, 0);
    const made = key.ensure();

    assert.match(made, KEY_SHAPE);
    assert.equal(area.items.get(`${VISITOR_KEY_PREFIX}site_acme`), made);
    assert.equal(key.current(), made);
    assert.equal(key.ensure(), made);
    // A second mount on the same page, or after a reload, reads the same key.
    assert.equal(createVisitorKey(area, 'site_acme').current(), made);
  });

  it('makes another key for another site, and for another browser', () => {
    const area = storage();
    const acme = createVisitorKey(area, 'site_acme').ensure();
    const globex = createVisitorKey(area, 'site_globex').ensure();
    const elsewhere = createVisitorKey(storage(), 'site_acme').ensure();

    assert.notEqual(acme, globex);
    assert.notEqual(acme, elsewhere);
  });

  it('takes 32 random bytes, in base64url with no padding', () => {
    const key = createVisitorKey(storage(), 'site_acme', (bytes) => bytes.fill(0xfb));

    assert.equal(key.ensure(), '-_v7'.repeat(10) + '-_s');
  });

  it('takes no stored value of another shape for a key, and puts a new one in its place', () => {
    const area = storage();
    area.items.set(`${VISITOR_KEY_PREFIX}site_acme`, 'written by the page');
    const key = createVisitorKey(area, 'site_acme');

    assert.equal(key.current(), undefined);
    const made = key.ensure();
    assert.match(made, KEY_SHAPE);
    assert.equal(area.items.get(`${VISITOR_KEY_PREFIX}site_acme`), made);
  });

  it('keeps the key in memory for the page when the browser refuses the storage', () => {
    const key = createVisitorKey(storage(true), 'site_acme');

    assert.equal(key.current(), undefined);
    const made = key.ensure();
    assert.equal(key.current(), made);
    assert.equal(createVisitorKey(null, 'site_acme').current(), undefined);
  });
});

describe('the key of a browser on the calls to the worker (FRU-700)', () => {
  const sent: TransportRequest[] = [];
  const transport = async (request: TransportRequest) => {
    sent.push(request);

    return { ok: true, status: 200, body: '{}' };
  };

  it('sends no key before a note, makes it with the note, then sends it with each call', async () => {
    sent.length = 0;
    const options = {
      endpoint: 'https://worker.test',
      clientId: 'site_acme',
      transport,
      visitor: createVisitorKey(storage(), 'site_acme'),
    };

    await callWorker(options, { url: 'https://worker.test/feedback?url=a', method: 'GET' });
    await callWorker(options, { url: 'https://worker.test/feedback', method: 'POST', body: '{}', asAuthor: true });
    await callWorker(options, { url: 'https://worker.test/feedback?url=a', method: 'GET' });

    const keys = sent.map((request) => request.headers[VISITOR_HEADER]);
    assert.equal(keys[0], undefined);
    assert.match(String(keys[1]), KEY_SHAPE);
    assert.equal(keys[2], keys[1]);
    // `asAuthor` is the widget's word, never sent.
    assert.equal('asAuthor' in (sent[1] as object), false);
  });

  it('sends no key from a mount that has none', async () => {
    sent.length = 0;
    await callWorker(
      { endpoint: 'https://worker.test', clientId: 'site_acme', transport },
      { url: 'https://worker.test/feedback', method: 'POST', body: '{}', asAuthor: true },
    );

    assert.equal(sent[0]?.headers[VISITOR_HEADER], undefined);
  });
});
