import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORE_EXTENSION_ID,
  ask,
  connectHere,
  extensionIdsFrom,
  findHere,
  hereProblemOf,
  parseHello,
} from './extension-here.ts';

const ID = 'abcdefghijklmnopabcdefghijklmnop';

/** A `chrome.runtime` of a page, with the extension `ID` answering `reply`. */
function chromeWith(reply: (message: Record<string, unknown>) => unknown) {
  const sent: Record<string, unknown>[] = [];
  const chrome = {
    lastError: undefined as unknown,
    sendMessage(id: string, message: unknown, answer: (response: unknown) => void) {
      sent.push(message as Record<string, unknown>);
      if (id !== ID) {
        chrome.lastError = { message: 'Could not establish connection. Receiving end does not exist.' };
        answer(undefined);
        chrome.lastError = undefined;

        return;
      }
      answer(reply(message as Record<string, unknown>));
    },
  };

  return { chrome, sent };
}

describe('the extensions the console asks (FRU-487)', () => {
  it('is the one of the store on the console of the Cloud, and none on a self-hosted one', () => {
    assert.match(STORE_EXTENSION_ID, /^[a-p]{32}$/);
    assert.deepEqual(extensionIdsFrom(undefined, 'https://api.fruitback.com'), [STORE_EXTENSION_ID]);
    assert.deepEqual(extensionIdsFrom(undefined, 'https://fruitback.acme.dev'), []);
    assert.deepEqual(extensionIdsFrom({ api: 'https://fruitback.acme.dev' }, 'https://fruitback.acme.dev'), []);
  });

  it('is what `/config.js` names, ids of Chrome only', () => {
    assert.deepEqual(extensionIdsFrom({ extensionIds: [ID, 'not-an-id', 3] }, 'https://api.fruitback.com'), [ID]);
    assert.deepEqual(extensionIdsFrom({ extensionIds: [] }, 'https://api.fruitback.com'), []);
  });
});

describe('asking the extension of this browser (FRU-487)', () => {
  it('answers nothing in a browser with no `chrome.runtime`, as Firefox and Safari', async () => {
    assert.equal(await ask(ID, { type: 'fruitback:hello', v: 1 }, undefined), undefined);
    assert.equal(await findHere([ID], undefined), undefined);
  });

  it('finds the extension that answers `hello`, and whether it is signed in', async () => {
    const { chrome } = chromeWith(() => ({ v: 1, ok: true, signedIn: false }));
    assert.deepEqual(await findHere(['ponmlkjihgfedcbaponmlkjihgfedcba', ID], chrome), { id: ID, signedIn: false });
  });

  it('takes `hello` key by key', () => {
    assert.equal(parseHello({ v: 1, ok: true, signedIn: true }), true);
    assert.equal(parseHello({ v: 2, ok: true, signedIn: true }), undefined);
    assert.equal(parseHello({ v: 1, ok: true, signedIn: 'yes' }), undefined);
    assert.equal(parseHello(undefined), undefined);
  });
});

describe('connecting the extension in place (FRU-487)', () => {
  const pending = {
    request: 'req_1',
    state: 'pending' as const,
    word: 'PLUM 47',
    browser: 'Chrome on macOS',
    account: { id: 'u_1', email: 'ana@acme.dev' },
  };

  it('approves the request the extension started, with the word the worker gave, then lets it claim', async () => {
    let claims = 0;
    const { chrome, sent } = chromeWith((message) => {
      if (message.type === 'fruitback:connect') return { v: 1, ok: true, request: 'req_1' };
      claims += 1;

      return { v: 1, ok: true, state: claims < 2 ? 'waiting' : 'signed-in' };
    });
    const approved: unknown[] = [];
    const result = await connectHere(ID, {
      chrome,
      wait: async () => undefined,
      read: async (request) => {
        assert.equal(request, 'req_1');

        return { ok: true, data: pending };
      },
      approve: async (request, asked, yes) => {
        approved.push({ request, asked, yes });

        return { ok: true, data: { state: 'approved' } };
      },
    });

    assert.equal(result, 'connected');
    assert.deepEqual(approved, [{ request: 'req_1', asked: { word: 'PLUM 47', account: pending.account }, yes: true }]);
    assert.deepEqual(sent, [
      { type: 'fruitback:connect', v: 1 },
      { type: 'fruitback:claim', v: 1, request: 'req_1' },
      { type: 'fruitback:claim', v: 1, request: 'req_1' },
    ]);
  });

  it('approves nothing when the extension starts nothing', async () => {
    const { chrome } = chromeWith(() => ({ v: 1, ok: false, reason: 'unavailable' }));
    let read = false;
    const result = await connectHere(ID, {
      chrome,
      read: async () => {
        read = true;

        return { ok: true, data: pending };
      },
    });
    assert.equal(result, 'failed');
    assert.equal(read, false);
  });

  it('says signed out when the console has no session to approve with', async () => {
    const { chrome } = chromeWith(() => ({ v: 1, ok: true, request: 'req_1' }));
    const result = await connectHere(ID, {
      chrome,
      read: async () => ({ ok: false, status: 401, error: 'unauthorized' }),
    });
    assert.equal(result, 'signed-out');
  });

  it('approves nothing more when the worker refuses the approval: another account, a word, an expiry', async () => {
    for (const status of [409, 410, 422, 404]) {
      const { chrome, sent } = chromeWith(() => ({ v: 1, ok: true, request: 'req_1' }));
      const result = await connectHere(ID, {
        chrome,
        wait: async () => undefined,
        read: async () => ({ ok: true, data: pending }),
        approve: async () => ({ ok: false, status, error: 'refused' }),
      });
      assert.equal(result, 'failed', String(status));
      // No claim follows a refused approval.
      assert.deepEqual(sent, [{ type: 'fruitback:connect', v: 1 }]);
    }
  });

  it('approves nothing for a request that is not waiting', async () => {
    for (const state of ['refused', 'expired'] as const) {
      const { chrome } = chromeWith(() => ({ v: 1, ok: true, request: 'req_1' }));
      let approved = false;
      const result = await connectHere(ID, {
        chrome,
        read: async () => ({ ok: true, data: { ...pending, state } }),
        approve: async () => {
          approved = true;

          return { ok: true, data: {} };
        },
      });
      assert.equal(result, 'failed');
      assert.equal(approved, false);
    }
  });

  it('says « approved », not a failure, when the extension has not claimed yet, and a new press claims without a second approval', async () => {
    const { chrome, sent } = chromeWith((message) =>
      message.type === 'fruitback:connect'
        ? { v: 1, ok: true, request: 'req_1' }
        : { v: 1, ok: true, state: 'waiting' },
    );
    let approvals = 0;
    const seams = {
      chrome,
      wait: async () => undefined,
      read: async () => ({
        ok: true as const,
        data: approvals === 0 ? pending : { ...pending, state: 'approved' as const },
      }),
      approve: async () => {
        approvals += 1;

        return { ok: true as const, data: {} };
      },
    };
    assert.equal(await connectHere(ID, seams), 'approved');
    assert.equal(sent.filter((each) => each.type === 'fruitback:claim').length, 8);
    assert.equal(await connectHere(ID, seams), 'approved');
    assert.equal(approvals, 1);
  });

  it('reads a claim with no answer after the approval as « not yet », and never as a failure', async () => {
    let claims = 0;
    const { chrome } = chromeWith((message) => {
      if (message.type === 'fruitback:connect') return { v: 1, ok: true, request: 'req_1' };
      claims += 1;

      // The extension did not answer in time, then did.
      return claims === 1 ? undefined : { v: 1, ok: true, state: 'signed-in' };
    });
    const result = await connectHere(ID, {
      chrome,
      wait: async () => undefined,
      read: async () => ({ ok: true, data: pending }),
      approve: async () => ({ ok: true, data: {} }),
    });
    assert.equal(result, 'connected');
    assert.equal(claims, 2);
  });

  it('says « approved » when no claim is ever answered after the approval', async () => {
    const { chrome } = chromeWith((message) =>
      message.type === 'fruitback:connect' ? { v: 1, ok: true, request: 'req_1' } : undefined,
    );
    const result = await connectHere(ID, {
      chrome,
      wait: async () => undefined,
      read: async () => ({ ok: true, data: pending }),
      approve: async () => ({ ok: true, data: {} }),
    });
    assert.equal(result, 'approved');
  });

  it('says a failure when a read or an approval rejects, and never throws', async () => {
    const { chrome } = chromeWith(() => ({ v: 1, ok: true, request: 'req_1' }));
    assert.equal(
      await connectHere(ID, {
        chrome,
        read: async () => {
          throw new Error('network');
        },
      }),
      'failed',
    );
  });

  it('stops when the request ends otherwise', async () => {
    const { chrome } = chromeWith((message) =>
      message.type === 'fruitback:connect'
        ? { v: 1, ok: true, request: 'req_1' }
        : { v: 1, ok: true, state: 'refused' },
    );
    const result = await connectHere(ID, {
      chrome,
      wait: async () => undefined,
      read: async () => ({ ok: true, data: pending }),
      approve: async () => ({ ok: true, data: {} }),
    });
    assert.equal(result, 'failed');
  });
});

describe('what the card says after a try (FRU-487)', () => {
  it('names a session of the console that ended apart from a browser that was not connected', () => {
    assert.equal(hereProblemOf('connected'), undefined);
    assert.equal(hereProblemOf('signed-out'), 'Your session ended. Sign in again, then connect this browser.');
    assert.equal(hereProblemOf('failed'), 'This browser was not connected. Try again.');
    assert.match(hereProblemOf('approved') ?? '', /^Approved\./);
  });
});
