import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
  request as httpRequest,
} from 'node:http';
import type { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { ROUTINE_ORIGIN } from './claude-routine.ts';
import type { Send } from './rest-connector.ts';
import { createSender } from './rest-send.ts';

/**
 * A local `/fire` of Claude Code routines, as the documentation of 2026-11-06 describes it
 * (code.claude.com/docs/en/routines, « Trigger a scheduled task », « Usage and limits »). No real
 * routine is called by a test: a call starts a run on somebody's account.
 *
 * - `POST /v1/claude_code/routines/<trig_id>/fire`, `Authorization: Bearer <token of that task>`.
 *   A token of another task, or none: `401`.
 * - `anthropic-beta: experimental-cc-routine-2026-04-01` (the two dated versions before it still
 *   work, per the documentation; this fake knows only the current one) and `anthropic-version`.
 * - A JSON body with an optional string `text`, taken as a literal string.
 * - `200` with `type: routine_fire`, `claude_code_session_id`, `claude_code_session_url`.
 * - 30 fires an hour per task, then `429`.
 *
 * The error bodies are not documented on that page: the fake answers a small JSON, and the worker
 * reads only the status of an error.
 */

export type Fire = { trigger: string; headers: IncomingMessage['headers']; body: string; text?: string };

export const ROUTINE_BETA_ACCEPTED = ['experimental-cc-routine-2026-04-01'] as const;
export const FIRES_PER_HOUR_PER_TASK = 30;

export async function fakeRoutines(tasks: Record<string, string>): Promise<{
  server: Server;
  /** Each call that reached the fake, accepted or not. */
  fires: Fire[];
  /** A sender that sends a call of `https://api.anthropic.com` to this fake, on the loopback. */
  send: Send;
  /** The address of the fake. */
  origin: string;
  /** What the next answers are: `undefined` answers as the documentation says. */
  next: { status?: number; body?: string };
}> {
  const fires: Fire[] = [];
  const counts = new Map<string, number>();
  const next: { status?: number; body?: string } = {};
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      const answer = (status: number, json: unknown): void => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(json));
      };
      const path = /^\/v1\/claude_code\/routines\/(trig_[A-Za-z0-9]+)\/fire$/.exec(request.url ?? '');
      const trigger = path?.[1] ?? '';
      const fire: Fire = { trigger, headers: request.headers, body };
      fires.push(fire);
      if (request.method !== 'POST' || path === null) return answer(404, { type: 'error', error: 'not_found' });
      if (next.status !== undefined) {
        response.writeHead(next.status, { 'Content-Type': 'application/json' });
        response.end(next.body ?? '{}');

        return;
      }
      const token = tasks[trigger];
      if (token === undefined || request.headers.authorization !== `Bearer ${token}`) {
        return answer(401, { type: 'error', error: 'authentication_error' });
      }
      if (!(ROUTINE_BETA_ACCEPTED as readonly string[]).includes(String(request.headers['anthropic-beta']))) {
        return answer(400, { type: 'error', error: 'invalid_beta' });
      }
      if (request.headers['anthropic-version'] === undefined) {
        return answer(400, { type: 'error', error: 'missing_version' });
      }
      let parsed: unknown;
      try {
        parsed = body === '' ? {} : JSON.parse(body);
      } catch {
        return answer(400, { type: 'error', error: 'invalid_json' });
      }
      const text = (parsed as { text?: unknown }).text;
      if (text !== undefined && typeof text !== 'string') return answer(400, { type: 'error', error: 'invalid_text' });
      if (typeof text === 'string') fire.text = text;
      const count = (counts.get(trigger) ?? 0) + 1;
      counts.set(trigger, count);
      if (count > FIRES_PER_HOUR_PER_TASK) return answer(429, { type: 'error', error: 'rate_limited' });
      const session = `session_01${String(fires.length).padStart(22, 'X')}`;

      return answer(200, {
        type: 'routine_fire',
        claude_code_session_id: session,
        claude_code_session_url: `https://claude.ai/code/${session}`,
      });
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sender = createSender({
    request: httpRequest as unknown as typeof httpsRequest,
    allows: () => true,
    timeoutMs: 2_000,
  });
  // The worker keeps only the origin of Anthropic: the fake takes its place on the loopback here, and
  // nowhere in the code of the worker.
  const send: Send = (url, headers, body, options) =>
    sender(
      url.startsWith(`${ROUTINE_ORIGIN}/`) ? `${origin}${url.slice(ROUTINE_ORIGIN.length)}` : url,
      headers,
      body,
      options,
    );

  return { server, fires, send, origin, next };
}
