import type { Seed } from '@fruitback/shared';

/**
 * Plant one pin through a running worker, then read it back (SKG-541).
 *
 * The CI image job runs this against `docker-compose.yml`, started from a directory that holds only
 * that file and a `.env`. Run it once to plant. Then recreate the container and run it with `--read`:
 * the pin must still be there, which proves the seeds are on the volume.
 *
 *   node apps/worker/src/plant-a-pin.ts http://127.0.0.1:8080
 *   node apps/worker/src/plant-a-pin.ts http://127.0.0.1:8080 --read
 *
 * The only import is a type, which Node erases, so the script runs with no `pnpm install`.
 */
export const PIN_SEED: Seed = {
  kind: 'fruitback.seed',
  v: 2,
  id: 'sd_compose_smoke',
  createdAt: '2026-09-14T00:00:00.000Z',
  note: 'Planted by the compose smoke test',
  page: { url: 'https://staging.example.com/', path: '/' },
  viewport: { width: 1280, height: 800 },
  anchor: { selector: 'main > h1', tag: 'h1', bounds: { xPct: 0, yPct: 0, wPct: 100, hPct: 8 } },
};

export async function plantAPin(endpoint: string, options: { plant: boolean }): Promise<void> {
  const health = await fetch(`${endpoint}/health`);
  const status = await health.text();
  if (health.status !== 200) throw new Error(`/health answered ${health.status}: ${status}`);

  if (options.plant) {
    const posted = await fetch(`${endpoint}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(PIN_SEED),
    });
    if (posted.status !== 201) throw new Error(`POST /feedback answered ${posted.status}: ${await posted.text()}`);
  }

  const read = await fetch(`${endpoint}/feedback?url=${encodeURIComponent(PIN_SEED.page.url)}`);
  const body = await read.text();
  const issues =
    read.status === 200 ? ((JSON.parse(body) as { issues?: { seed?: { id?: string } }[] }).issues ?? []) : [];
  if (!issues.some((issue) => issue.seed?.id === PIN_SEED.id)) {
    throw new Error(`GET /feedback answered ${read.status} without the pin: ${body}`);
  }
}

if (import.meta.main) {
  const [endpoint, flag] = process.argv.slice(2);
  if (endpoint === undefined) {
    console.error('usage: node plant-a-pin.ts <endpoint> [--read]');
    process.exit(2);
  }

  try {
    await plantAPin(endpoint, { plant: flag !== '--read' });
    console.log(flag === '--read' ? 'the pin is still there' : 'planted a pin and read it back');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
