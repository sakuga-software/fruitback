import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalizePageUrl, parseSeedFromDescription } from '@fruitback/shared';
import { seedFixture } from '@fruitback/shared/seed.fixture';
import worker from './index';
import type { WorkerEnv } from './env';
import { installLinearStub } from './linear-stub';
import { resetRateLimitState } from './rate-limit';

const ORIGIN = 'https://preview.acme.test';

const env: WorkerEnv = {
  LINEAR_API_KEY: 'lin_api_test',
  LINEAR_TEAM_ID: 'team_1',
  LINEAR_PROJECT_ID: 'project_1',
  ALLOWED_ORIGINS: `${ORIGIN},http://localhost:5173`,
};

function post(body: unknown, init: { origin?: string | null; env?: WorkerEnv; headers?: HeadersInit } = {}) {
  const headers = new Headers({ 'Content-Type': 'application/json', ...(init.headers ?? {}) });
  if (init.origin !== null) headers.set('Origin', init.origin ?? ORIGIN);

  const request = new Request('https://worker.fruitback.dev/feedback', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

  return worker.fetch(request, init.env ?? env);
}

beforeEach(() => {
  resetRateLimitState();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /feedback', () => {
  it('creates a Linear issue and returns its identifier and URL', async () => {
    const stub = installLinearStub({ existingLabels: { fruitback: 'label_existing' } });

    const response = await post(seedFixture());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      issue: { id: 'issue_1', identifier: 'SKG-999', url: 'https://linear.app/sakuga-software/issue/SKG-999' },
    });
    expect(stub.issueInput().teamId).toBe('team_1');
    expect(stub.issueInput().projectId).toBe('project_1');
  });

  it('stores a description the widget can parse back into the exact same seed', async () => {
    // The whole read path depends on this. If it breaks, pins can never be re-planted.
    const stub = installLinearStub();
    const seed = seedFixture();

    await post(seed);

    const result = parseSeedFromDescription(stub.issueInput().description);
    expect(result).toEqual({ ok: true, seed });
  });

  it('titles the issue with the visitor own words', async () => {
    const stub = installLinearStub();

    await post(seedFixture({ note: 'Le CTA est trop petit' }));

    expect(stub.issueInput().title).toBe('Le CTA est trop petit');
  });

  it('applies the fruitback label and the client label, creating what is missing', async () => {
    const stub = installLinearStub({ existingLabels: { fruitback: 'label_existing' } });

    await post(seedFixture());

    expect(stub.createdLabels()).toEqual(['fruitback:acme']);
    expect(stub.issueInput().labelIds).toEqual(['label_existing', 'label_1']);
  });

  it('still plants the seed when a label cannot be created', async () => {
    // Losing a label is a triage annoyance; losing the client's feedback is a bug.
    const stub = installLinearStub({ failLabelCreation: true });

    const response = await post(seedFixture());

    expect(response.status).toBe(201);
    expect(stub.issueInput().labelIds).toEqual([]);
  });

  it('normalizes the page URL server-side', async () => {
    // A client that skipped normalization would otherwise plant a pin the read path cannot find.
    const stub = installLinearStub();
    const raw = 'https://preview.acme.test/pricing/?utm_source=ads&tab=annual#cta';

    await post(seedFixture({ page: { url: raw, path: '/pricing' } }));

    const result = parseSeedFromDescription(stub.issueInput().description);
    expect(result.ok && result.seed.page.url).toBe(canonicalizePageUrl(raw));
  });

  it('rejects a payload that is not a seed', async () => {
    installLinearStub();

    const response = await post({ hello: 'world' });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid-seed', reason: 'not-found' });
  });

  it('rejects malformed JSON', async () => {
    installLinearStub();

    const response = await post('{ not json');

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid-json' });
  });

  it('rejects an oversized body', async () => {
    installLinearStub();
    // Built as raw JSON: the schema caps a note at 5 000 chars, so `createSeed` would refuse this.
    const oversized = JSON.stringify({ ...seedFixture(), note: 'x'.repeat(70_000) });

    const response = await post(oversized);

    expect(response.status).toBe(413);
  });

  it('reports a Linear outage as 502 so the widget can keep the note and retry', async () => {
    installLinearStub({ failIssueCreation: true });

    const response = await post(seedFixture());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: 'linear-unavailable' });
  });
});

describe('CORS', () => {
  it('echoes an allowed origin and varies on it', async () => {
    installLinearStub();

    const response = await post(seedFixture());

    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(response.headers.get('Vary')).toBe('Origin');
  });

  it('refuses an origin that is not on the allowlist', async () => {
    installLinearStub();

    const response = await post(seedFixture(), { origin: 'https://evil.test' });

    expect(response.status).toBe(403);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('allows any origin when configured with a wildcard', async () => {
    installLinearStub();

    const response = await post(seedFixture(), {
      origin: 'https://anything.test',
      env: { ...env, ALLOWED_ORIGINS: '*' },
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://anything.test');
  });

  it('answers the preflight without touching Linear', async () => {
    const stub = installLinearStub();
    const request = new Request('https://worker.fruitback.dev/feedback', {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN },
    });

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it('serves a request with no Origin at all (curl, health check)', async () => {
    installLinearStub();

    const response = await post(seedFixture(), { origin: null });

    expect(response.status).toBe(201);
  });
});

describe('guard rails', () => {
  it('rate-limits a client hammering the endpoint', async () => {
    installLinearStub();
    const headers = { 'CF-Connecting-IP': '203.0.113.7' };

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 21; attempt += 1) {
      statuses.push((await post(seedFixture(), { headers })).status);
    }

    expect(statuses.slice(0, 20).every((status) => status === 201)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it('prefers the Cloudflare rate limiter when the binding exists', async () => {
    installLinearStub();
    const limit = vi.fn(async () => ({ success: false }));

    const response = await post(seedFixture(), { env: { ...env, FEEDBACK_RATE_LIMITER: { limit } } });

    expect(response.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: 'unknown' });
  });

  it('says what is missing when the Worker is misconfigured', async () => {
    installLinearStub();

    const response = await post(seedFixture(), { env: { ALLOWED_ORIGINS: ORIGIN } });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: 'misconfigured',
      missing: ['LINEAR_API_KEY', 'LINEAR_TEAM_ID'],
    });
  });
});

describe('routing', () => {
  it('reports the read path as not implemented yet', async () => {
    const request = new Request('https://worker.fruitback.dev/feedback?url=https://acme.test/', {
      headers: { Origin: ORIGIN },
    });

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toEqual({ error: 'not-implemented', ticket: 'SKG-499' });
  });

  it('404s an unknown path', async () => {
    const request = new Request('https://worker.fruitback.dev/nope', { headers: { Origin: ORIGIN } });

    const response = await worker.fetch(request, env);

    expect(response.status).toBe(404);
  });
});
