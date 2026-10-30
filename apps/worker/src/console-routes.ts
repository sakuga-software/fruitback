import type { AccountStore } from './accounts.ts';
import { authFor } from './auth.ts';
import {
  createWorkspaceWithPlugin,
  handleOrganizationRoutes,
  mailAdminInvitation,
  oneAtATime,
  renameWorkspaceWithPlugin,
} from './auth-organization.ts';
import { AuthUnavailable, handleAuthRoutes, isAuthRoute, sessionOfCookie } from './auth-routes.ts';
import { handleEmailRoutes, isEmailRoute } from './account-emails.ts';
import { handleConsoleApi } from './console-api.ts';
import { SIGN_IN_PROVIDERS } from './console-cors.ts';
import { handleConsoleConnect } from './connect-routes.ts';
import { handleConsoleOAuth, issuerOf } from './oauth.ts';
import type { CorsDecision } from './cors.ts';
import { instanceFactsOf } from './instance-admin.ts';
import { type Kv, KvError } from './kv.ts';
import { handleGithubAppFlow } from './github-app-flow.ts';
import type { GithubApp } from './github-connector.ts';
import { handleLinearOAuth } from './linear-oauth.ts';
import type { NoteIndex } from './notes-index.ts';
import { withoutAddress } from './postgres.ts';
import type { RequestContext, Served } from './request-context.ts';
import { StoreError } from './store.ts';
import { connectStoreFor, instanceAdminFor, mailerFor, sessionStoreFor } from './worker-stores.ts';

/**
 * The routes of the console (FRU-363), out of `app.ts` so that a review reads them in one file: the
 * ways to sign in, the routes of better-auth and of its organization plugin, the way to Linear and
 * back, the approval of an extension, and the API of the console. `app.ts` sends a request here once
 * its origin is the console's, its method is allowed and the limit of its caller let it through.
 */

/** What `app.ts` knows of one request to the console, and the routes of this file do not. */
export type ConsoleSeams = {
  served: Served;
  context: RequestContext;
  /** The accounts of this worker: the console has no route on a worker that keeps none. */
  accounts: AccountStore;
  kv: Kv;
  noteIndex: NoteIndex | undefined;
  /** The CORS decision of the console for this request, already allowed. */
  cors: CorsDecision;
  /** The GitHub App of the workspace connectors (FRU-359), when this worker has one. */
  githubApp?: GithubApp;
};

export async function handleConsole(request: Request, pathname: string, seams: ConsoleSeams): Promise<Response> {
  const { served, context, accounts, kv, noteIndex, cors, githubApp } = seams;
  const sessions = context.sessionStore ?? sessionStoreFor(served);
  if (sessions === undefined || served.identitySecret === undefined)
    return json(404, { error: 'not-found' }, cors.headers);
  // better-auth, when it is on (FRU-147): the instance of the process, built at boot.
  const auth = context.auth ?? authFor(served);
  const mailer = context.mailer ?? mailerFor(served);

  try {
    // Which ways the routes of better-auth offer (FRU-135, FRU-147): the console asks before it
    // draws a button. `betterAuth` is absent when it is off: then nobody signs in to the console.
    // The two booleans of the path of before are gone with it (FRU-150).
    if (pathname === SIGN_IN_PROVIDERS && request.method === 'GET') {
      return json(
        200,
        auth === undefined
          ? {}
          : {
              betterAuth: {
                email: mailer !== undefined,
                github: served.authGithub !== undefined,
                google: served.google !== undefined,
              },
            },
        cors.headers,
      );
    }

    // The routes of better-auth, and the worker's own beside them (FRU-147). A worker that has it
    // off answers `404` there, as before.
    if (isAuthRoute(pathname) || isEmailRoute(pathname)) {
      if (auth === undefined || served.consoleUrl === undefined) return json(404, { error: 'not-found' }, cors.headers);
      try {
        const routes = {
          auth,
          accounts,
          mailer,
          kv,
          consoleUrl: served.consoleUrl,
          clientIp: context.clientIp,
          trackIp: served.authTrackIp,
          sessions,
        };
        // The routes of the organization plugin first, each under its rule (FRU-149). A path of the
        // plugin that has none answers `404` there, and never reaches the list below.
        // The addresses of the account (FRU-450), beside its ways to sign in.
        if (isEmailRoute(pathname)) return await handleEmailRoutes(request, pathname, routes, cors.headers);
        const answer =
          (await handleOrganizationRoutes(request, pathname, routes, cors.headers)) ??
          (await handleAuthRoutes(request, pathname, routes, cors.headers));
        if (answer !== undefined) return answer;
      } catch (error) {
        // A `Kv` that stopped is not better-auth: it is answered above, as the limiter's outage.
        if (error instanceof StoreError || error instanceof KvError) throw error;
        // better-auth rejects, and does not answer, on a schema that is not the one it expects, or
        // a database that does not answer (FRU-144). Said in the log, with no address and no token.
        const said = error instanceof Error ? error.message : String(error);
        console.error(
          `[fruitback] better-auth did not answer: ${served.databaseUrl === undefined ? said : withoutAddress(said, served.databaseUrl)}`,
        );

        return json(502, { error: 'auth-unavailable' }, cors.headers);
      }
    }

    // The way to Linear and back, for a workspace that connects it (FRU-134). Navigations too.
    if (
      served.linearOAuth !== undefined &&
      served.publicUrl !== undefined &&
      served.consoleUrl !== undefined &&
      served.secretsKey !== undefined
    ) {
      const viaLinear = await handleLinearOAuth(request, pathname, {
        oauth: served.linearOAuth,
        publicUrl: served.publicUrl,
        consoleUrl: served.consoleUrl,
        accounts,
        kv,
        secretsKey: served.secretsKey,
      });
      if (viaLinear !== undefined) return viaLinear;
    }

    // The installation of the GitHub App on a workspace (FRU-360). Navigations too.
    if (
      githubApp !== undefined &&
      served.publicUrl !== undefined &&
      served.consoleUrl !== undefined &&
      served.secretsKey !== undefined
    ) {
      const viaGithub = await handleGithubAppFlow(request, pathname, {
        app: githubApp,
        publicUrl: served.publicUrl,
        consoleUrl: served.consoleUrl,
        accounts,
        kv,
        secretsKey: served.secretsKey,
      });
      if (viaGithub !== undefined) return viaGithub;
    }

    // The extension asks, the console approves (FRU-238): a request, and the browsers of the account.
    const connect = context.connectStore ?? connectStoreFor(served);
    if (auth !== undefined && served.consoleUrl !== undefined && connect !== undefined) {
      const connected = await handleConsoleConnect(
        request,
        pathname,
        {
          connect,
          accounts,
          cookieSession: async (each: Request) => (await sessionOfCookie(auth, each))?.userId,
          consoleUrl: served.consoleUrl,
        },
        cors.headers,
      );
      if (connected !== undefined) return connected;
    }

    // A person approves a client of OAuth (FRU-467): the request it made, and the two answers.
    const issuer = issuerOf(served.publicUrl);
    if (auth !== undefined && served.consoleUrl !== undefined && issuer !== undefined) {
      const consented = await handleConsoleOAuth(
        request,
        pathname,
        {
          accounts,
          kv,
          issuer,
          consoleUrl: served.consoleUrl,
          cookieSession: async (each: Request) => (await sessionOfCookie(auth, each))?.userId,
        },
        cors.headers,
      );
      if (consented !== undefined) return consented;
    }

    const answer = await handleConsoleApi(
      request,
      pathname,
      {
        accounts,
        sessions,
        ...(served.secretsKey === undefined ? {} : { secretsKey: served.secretsKey }),
        kv,
        ...(noteIndex === undefined ? {} : { noteIndex }),
        ...(served.linearOAuth === undefined ? {} : { linearOAuth: served.linearOAuth }),
        ...(githubApp === undefined ? {} : { githubApp }),
        ...(served.publicUrl === undefined ? {} : { publicUrl: served.publicUrl }),
        ...(context.resolveTxt === undefined ? {} : { resolveTxt: context.resolveTxt }),
        // The administrator of the instance (FRU-261): the database of the accounts, and this configuration.
        instance: {
          reads: context.instanceAdmin ?? instanceAdminFor(served),
          facts: instanceFactsOf(served, { auth: auth !== undefined, email: mailer !== undefined }),
          // The writes in a workspace (FRU-283): one at a time with the plugin, and the message of
          // an invitation as a member's, when this worker sends mail.
          writes: {
            oneAtATime,
            ...(mailer === undefined || served.consoleUrl === undefined
              ? {}
              : {
                  mailInvitation: (invitation) =>
                    mailAdminInvitation({ kv, mailer, consoleUrl: served.consoleUrl as string, accounts }, invitation),
                }),
          },
        },
        // Who calls is the person of the cookie of better-auth (FRU-147), and nobody without it.
        ...(auth === undefined || served.consoleUrl === undefined
          ? {}
          : {
              cookieSession: async (each: Request) => (await sessionOfCookie(auth, each))?.userId,
              consoleUrl: served.consoleUrl,
              // A workspace is made by the organization plugin for somebody of the cookie (FRU-149).
              createWorkspace: async (each: Request, name: string) =>
                createWorkspaceWithPlugin(await auth, each.headers, name),
              // And renamed by it (FRU-236).
              renameWorkspace: async (each: Request, workspace: string, name: string) =>
                renameWorkspaceWithPlugin(await auth, each.headers, workspace, name),
            }),
      },
      cors.headers,
    );

    return answer ?? json(404, { error: 'not-found' }, cors.headers);
  } catch (error) {
    if (error instanceof StoreError) return json(502, { error: 'store-unavailable' }, cors.headers);
    // The cookie of a call of the console is read by better-auth (FRU-147): the same answer as on
    // its own routes when it does not answer.
    if (error instanceof AuthUnavailable) {
      console.error(
        `[fruitback] better-auth did not answer: ${served.databaseUrl === undefined ? error.message : withoutAddress(error.message, served.databaseUrl)}`,
      );

      return json(502, { error: 'auth-unavailable' }, cors.headers);
    }
    throw error;
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}
