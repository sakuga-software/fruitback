import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { refusalOf } from './authorize-answer.ts';
import { SERVER_PROBLEM, WORKSPACE_SUSPENDED } from './problems.ts';

describe('a refused answer of « Connect an agent » (FRU-467)', () => {
  it('says the request is gone only for a 404: unknown, ended or answered', () => {
    assert.deepEqual(refusalOf({ status: 404, error: 'request-unknown' }), { is: 'gone' });
  });

  it('keeps the page for a 409 the worker answers before it spends the request, and says why', () => {
    assert.deepEqual(refusalOf({ status: 409, error: 'too-many-keys' }), {
      is: 'refused',
      problem: 'This workspace holds 20 agents already. Revoke one in Agents, then start again.',
    });
    assert.deepEqual(refusalOf({ status: 409, error: 'workspace-suspended' }), {
      is: 'refused',
      problem: WORKSPACE_SUSPENDED,
    });
    for (const error of ['account-changed', 'tab-left']) {
      const refusal = refusalOf({ status: 409, error });
      assert.equal(refusal.is, 'refused');
      assert.match(refusal.is === 'refused' ? refusal.problem : '', /another account/);
    }
  });

  it('sends a signed-out person to the sign-in, and says « did not answer » for the rest', () => {
    assert.deepEqual(refusalOf({ status: 401, error: 'unauthorized' }), { is: 'signed-out' });
    assert.deepEqual(refusalOf({ status: 500, error: 'internal' }), { is: 'refused', problem: SERVER_PROBLEM });
  });
});
