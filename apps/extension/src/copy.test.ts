import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyAddressOfStack, createPairing, holderOf, proofOf, tagOf } from './copy.ts';
import { CHANNEL, LEGACY_CHANNEL, type ReadyMessage, parseBridgeMessage } from './protocol.ts';
import { parseAnswer } from './tab-command.ts';

/** One copy drives a page (FRU-397): the tag, the proof, and what a bridge takes. */

const MINE = 'jjjemdloknmggncbickofjgbodplekoa';
const OTHER = 'aahkcphohkckfigfadomaoilhfhkhpkl';

function readyOf(address: string | undefined, tag: string, more: Partial<ReadyMessage> = {}) {
  const data = {
    channel: CHANNEL,
    kind: 'ready',
    copy: tag,
    ...(address === undefined ? {} : { proof: proofOf(address, tag) }),
    ...more,
  };

  return { data, ready: parseBridgeMessage(data) as ReadyMessage };
}

describe('the address of a copy, read from its own stack', () => {
  it('reads it on Chrome and on Firefox, and nothing from a stack of the page', () => {
    assert.equal(
      copyAddressOfStack(`Error\n    at main (chrome-extension://${MINE}/content-scripts/page.js:428:12)`),
      MINE,
    );
    assert.equal(
      copyAddressOfStack('main@moz-extension://0f6d8c1e-2b7a-4c55-9d1e-3a4b5c6d7e8f/content-scripts/page.js:1:9'),
      '0f6d8c1e-2b7a-4c55-9d1e-3a4b5c6d7e8f',
    );
    assert.equal(copyAddressOfStack('Error\n    at https://app.example/assets/index.js:1:2'), undefined);
    assert.equal(copyAddressOfStack(undefined), undefined);
  });
});

describe('the proof of a tag', () => {
  it('is 16 hexadecimal digits, the same for the same copy and tag, another for another copy', () => {
    const proof = proofOf(MINE, 'tag-1');
    assert.match(proof, /^[0-9a-f]{16}$/);
    assert.equal(proofOf(MINE, 'tag-1'), proof);
    assert.notEqual(proofOf(OTHER, 'tag-1'), proof);
    assert.notEqual(proofOf(MINE, 'tag-2'), proof);
    // The address is not in it.
    assert.doesNotMatch(proof, new RegExp(MINE));
  });
});

describe('who holds the page, for a page script that starts', () => {
  it('finds it free, held by its own copy, by another copy with its version, or by a copy of before', () => {
    assert.equal(holderOf(undefined, undefined, MINE), 'free');
    const mine = { tag: 't', proof: proofOf(MINE, 't'), version: '0.4.0' };
    assert.equal(holderOf(true, mine, MINE), 'mine');
    assert.deepEqual(holderOf(true, mine, OTHER), { version: '0.4.0' });
    // 0.1.0 to 0.3.0 set the flag and nothing else.
    assert.deepEqual(holderOf(true, undefined, MINE), {});
  });

  it('steps aside as before when no address tells two copies apart', () => {
    assert.equal(holderOf(true, { tag: 't', version: '0.4.0' }, MINE), 'mine');
    assert.equal(holderOf(true, { tag: 't', proof: proofOf(OTHER, 't') }, undefined), 'mine');
  });
});

describe('the bridge hears the page script of its own copy, and no other (FRU-397)', () => {
  it('takes the tag whose proof its address gives, and refuses the tag of another copy', () => {
    const pairing = createPairing(MINE);
    const theirs = readyOf(OTHER, 'theirs', { version: '0.4.1' });
    assert.equal(pairing.read(theirs.data, theirs.ready), 'foreign');
    assert.equal(pairing.tag(), undefined);
    assert.deepEqual(pairing.other(), { version: '0.4.1' });

    const ours = readyOf(MINE, 'ours');
    assert.equal(pairing.read(ours.data, ours.ready), 'paired');
    assert.equal(pairing.tag(), 'ours');

    // A mount of the bridge of the other copy, and a relay request of its page script.
    assert.equal(pairing.read({ channel: CHANNEL, kind: 'relay-request', copy: 'theirs' }, undefined), 'foreign');
    assert.equal(pairing.read({ channel: CHANNEL, kind: 'relay-request', copy: 'ours' }, undefined), 'ours');
    // No tag: heard by nobody.
    assert.equal(pairing.read({ channel: CHANNEL, kind: 'relay-request' }, undefined), 'foreign');
  });

  it('hears nothing on the channel of before, and takes it as another copy', () => {
    const pairing = createPairing(MINE);
    const ours = readyOf(MINE, 'ours');
    pairing.read(ours.data, ours.ready);
    assert.equal(pairing.other(), undefined);

    // The 0.1.0 of the measure: its bridge says its decision on the channel of before.
    const legacy = { channel: LEGACY_CHANNEL, kind: 'mount', endpoint: 'https://worker.test', clientId: 'fruitback' };
    assert.equal(pairing.read(legacy, undefined), 'foreign');
    assert.equal(parseBridgeMessage(legacy), undefined);
    assert.deepEqual(pairing.other(), {});
    // The call this bridge sends to the bridges of before is not one.
    const probed = createPairing(MINE);
    probed.read({ channel: LEGACY_CHANNEL, kind: 'ready', probe: true }, undefined);
    assert.equal(probed.other(), undefined);
  });

  it('knows that its page script stepped aside, and who holds the page', () => {
    const pairing = createPairing(MINE);
    const aside = readyOf(MINE, 'ours', { heldBy: { version: '0.1.0' } });
    assert.equal(pairing.read(aside.data, aside.ready), 'paired');
    assert.equal(pairing.steppedAside(), true);
    assert.deepEqual(pairing.other(), { version: '0.1.0' });
  });

  it('takes a ready with no proof while no proven one came, as before', () => {
    const pairing = createPairing(MINE);
    const unproven = readyOf(undefined, 'first');
    assert.equal(pairing.read(unproven.data, unproven.ready), 'paired');
    const proven = readyOf(MINE, 'second');
    assert.equal(pairing.read(proven.data, proven.ready), 'paired');
    assert.equal(pairing.tag(), 'second');
    const late = readyOf(undefined, 'third');
    assert.equal(pairing.read(late.data, late.ready), 'foreign');
    assert.equal(pairing.tag(), 'second');
  });

  it('reads the tag of a message, and nothing that is not one', () => {
    assert.equal(tagOf({ copy: 'abc' }), 'abc');
    assert.equal(tagOf({ copy: '' }), undefined);
    assert.equal(tagOf({ copy: 'x'.repeat(65) }), undefined);
    assert.equal(tagOf({ copy: 1 }), undefined);
    assert.equal(tagOf(null), undefined);
  });
});

describe('what crosses the channel about another copy', () => {
  it('parses a ready with its proof, its version and who holds the page, and nothing else', () => {
    const proof = proofOf(MINE, 't');
    assert.deepEqual(
      parseBridgeMessage({
        channel: CHANNEL,
        kind: 'ready',
        copy: 't',
        proof,
        version: '0.4.0',
        heldBy: { version: '0.1.0', extra: 1 },
        extra: true,
      }),
      { channel: CHANNEL, kind: 'ready', proof, version: '0.4.0', heldBy: { version: '0.1.0' } },
    );
    assert.deepEqual(
      parseBridgeMessage({ channel: CHANNEL, kind: 'ready', proof: 'not-a-proof', version: '<b>', heldBy: {} }),
      { channel: CHANNEL, kind: 'ready', heldBy: {} },
    );
  });

  it('hands the popup the other copy, with a version only when it is one', () => {
    assert.deepEqual(parseAnswer({ done: false, otherCopy: { version: '0.1.0' } }), {
      done: false,
      otherCopy: { version: '0.1.0' },
    });
    assert.deepEqual(parseAnswer({ done: true, otherCopy: { version: 'javascript:1' } }), {
      done: true,
      otherCopy: {},
    });
    assert.deepEqual(parseAnswer({ done: true }), { done: true });
  });
});
