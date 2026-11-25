import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addressesIn, addressesWithout } from './invite-addresses.ts';

describe('the addresses of « Invite people » (FRU-691)', () => {
  it('cuts what is typed at a comma, a semicolon, a space or a new line', () => {
    assert.deepEqual(addressesIn('zoe@client.fr, paul@client.fr;lou@client.fr\nana@acme.dev  tom@acme.dev'), {
      valid: ['zoe@client.fr', 'paul@client.fr', 'lou@client.fr', 'ana@acme.dev', 'tom@acme.dev'],
      invalid: [],
    });
  });

  it('counts only what the worker keeps: one @, a dot after it, 254 characters at most', () => {
    const long = `${'a'.repeat(250)}@b.fr`;
    assert.deepEqual(addressesIn(`zoe@client.fr tom@acme paul @client.fr a@b@c.fr ${long}`), {
      valid: ['zoe@client.fr'],
      invalid: ['tom@acme', 'paul', '@client.fr', 'a@b@c.fr', long],
    });
    // The control: 254 characters is an address.
    const longest = `${'a'.repeat(249)}@b.fr`;
    assert.equal(longest.length, 254);
    assert.deepEqual(addressesIn(longest).valid, [longest]);
  });

  it('counts an address once, whatever its case', () => {
    assert.deepEqual(addressesIn('Zoe@Client.fr, zoe@client.fr, ZOE@CLIENT.FR').valid, ['zoe@client.fr']);
  });

  it('counts nothing in an empty field, or in commas and spaces', () => {
    assert.deepEqual(addressesIn(''), { valid: [], invalid: [] });
    assert.deepEqual(addressesIn(' , ;\n '), { valid: [], invalid: [] });
  });

  it('keeps what did not go and what is no address, and takes away what was sent', () => {
    const typed = 'zoe@client.fr, tom@acme, paul@client.fr, lou@client.fr';
    assert.equal(addressesWithout(typed, ['zoe@client.fr', 'lou@client.fr']), 'paul@client.fr, tom@acme');
    assert.equal(addressesWithout(typed, ['zoe@client.fr', 'paul@client.fr', 'lou@client.fr']), 'tom@acme');
    assert.equal(addressesWithout('zoe@client.fr', ['zoe@client.fr']), '');
  });

  it('keeps what was typed while the invitations went', () => {
    // « ana@acme.dev » was added during the send of the two others.
    assert.equal(
      addressesWithout('zoe@client.fr, lou@client.fr, ana@acme.dev', ['zoe@client.fr', 'lou@client.fr']),
      'ana@acme.dev',
    );
    // An address that went, typed again in another case, is taken away all the same.
    assert.equal(addressesWithout('ZOE@client.fr', ['zoe@client.fr']), '');
  });
});
