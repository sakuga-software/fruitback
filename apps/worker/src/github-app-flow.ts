import { type AccountStore, can } from './accounts.ts';
import { type GithubApp, installationFingerprint, sealInstallation } from './github-connector.ts';
import type { Kv } from './kv.ts';
import { STATE_TTL_MS, issueTicket, random, redirect, spendState, spendTicket, stateCookie } from './oauth-flow.ts';

/**
 * An owner or an admin installs the GitHub App on a workspace (FRU-360).
 *
 * The console gets a ticket, and the browser goes to `/auth/github-app/start`, which sends it to
 * `https://github.com/apps/<slug>/installations/new` with a `state` bound to the browser by a cookie,
 * as Linear's flow does. GitHub sends the person back to `/auth/github-app/callback` with the
 * `installation_id`, the `setup_action` and a `code` of the person.
 *
 * **The `installation_id` of the callback is what the browser says, not what GitHub says.** Anybody
 * can write another client's id there. So the worker changes the `code` for a user token, reads every
 * installation that this person reaches (`GET /user/installations`), and attaches the id only if it
 * is one of them. The user token serves this check only: it is kept nowhere and logged nowhere.
 */

export const GITHUB_APP_START = '/auth/github-app/start';
export const GITHUB_APP_CALLBACK = '/auth/github-app/callback';

const STATE_COOKIE = 'fruitback_github_app_state';
const TICKETS = 'fruitback:github-app-ticket:';
const STATES = 'fruitback:github-app-state:';
const INSTALLATION_ID = /^[1-9][0-9]{0,15}$/;

/** The label of a connector of the App. The console can read the prefix, as it reads the one of Linear. */
export const GITHUB_APP_LABEL_PREFIX = 'GitHub App · ';

export type GithubAppFlowContext = {
  app: GithubApp;
  /** The worker's public address, which GitHub sends the person back to. */
  publicUrl: string;
  consoleUrl: string;
  accounts: AccountStore;
  kv: Kv;
  secretsKey: string;
};

/** The address of the start, for this person in this workspace. The console sends the browser there. */
export async function githubAppTicket(
  context: Pick<GithubAppFlowContext, 'kv' | 'publicUrl'>,
  who: { workspace: string; account: string },
): Promise<string> {
  return `${context.publicUrl}${GITHUB_APP_START}?ticket=${await issueTicket(context.kv, TICKETS, who)}`;
}

/**
 * The words of the console, after `?github=`:
 *
 * - `connected`: the workspace holds the connector of the installation.
 * - `requested`: an owner of the organisation must approve the installation. Nothing is written.
 * - `elsewhere`: another workspace holds this installation.
 * - `refused`: the person does not reach this installation.
 * - `forbidden`, `suspended`: the role or the workspace changed during the flow.
 * - `failed`: anything else. GitHub said nothing usable.
 * - `unstarted`: the way back has no `state` of this browser (FRU-361), for example after an
 *   installation from github.com. It goes to `/`, because no workspace is known.
 */
type Word =
  | 'connected'
  | 'requested'
  | 'elsewhere'
  | 'refused'
  | 'forbidden'
  | 'suspended'
  | 'unauthorized-app'
  | 'failed'
  | 'unstarted';

/** Back to the connectors of the workspace, with a word. Nothing of GitHub is echoed. */
function back(context: GithubAppFlowContext, workspace: string | undefined, word: Word): Response {
  const root = word === 'unstarted' ? `/?github=${word}` : '/';
  const where = workspace === undefined ? root : `/w/${workspace}/connectors?github=${word}`;

  return redirect(`${context.consoleUrl}${where}`, [stateCookie(STATE_COOKIE, GITHUB_APP_CALLBACK, '', 0)]);
}

export async function handleGithubAppFlow(
  request: Request,
  pathname: string,
  context: GithubAppFlowContext,
): Promise<Response | undefined> {
  if (request.method !== 'GET') return undefined;
  if (pathname === GITHUB_APP_START) return start(request, context);
  if (pathname === GITHUB_APP_CALLBACK) return callback(request, context);

  return undefined;
}

async function start(request: Request, context: GithubAppFlowContext): Promise<Response> {
  const who = await spendTicket(context.kv, TICKETS, new URL(request.url).searchParams.get('ticket') ?? '');
  if (who === undefined) return back(context, undefined, 'failed');
  const slug = await context.app.slug().catch(() => undefined);
  if (slug === undefined) return back(context, who.workspace, 'failed');

  const state = random(24);
  await context.kv.set(`${STATES}${state}`, JSON.stringify(who), STATE_TTL_MS);
  const url = new URL(`https://github.com/apps/${slug}/installations/new`);
  url.searchParams.set('state', state);

  return redirect(url.toString(), [stateCookie(STATE_COOKIE, GITHUB_APP_CALLBACK, state, STATE_TTL_MS / 1_000)]);
}

async function callback(request: Request, context: GithubAppFlowContext): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const kept = await spendState(request, context.kv, { cookie: STATE_COOKIE, prefix: STATES });
  if (typeof kept?.workspace !== 'string' || typeof kept.account !== 'string')
    return back(context, undefined, 'unstarted');
  const { workspace, account } = kept as { workspace: string; account: string };

  // An organisation that asks its owners to approve sends the person back with no installation yet.
  const action = params.get('setup_action');
  if (action === 'request') return back(context, workspace, 'requested');
  // `update`: the App was on the organisation already, and the person changed its repositories.
  if (action !== 'install' && action !== 'update') return back(context, workspace, 'failed');
  const id = params.get('installation_id') ?? '';
  const code = params.get('code') ?? '';
  if (!INSTALLATION_ID.test(id)) return back(context, workspace, 'failed');
  // GitHub sends a code only when the App asks for the user authorization at its installation. Without
  // it, the worker cannot check who reaches the installation, and it attaches nothing.
  if (code === '') {
    console.error(
      '[fruitback] the GitHub App sent no code on its installation: turn on « Request user authorization (OAuth) during installation » in its settings',
    );

    return back(context, workspace, 'unauthorized-app');
  }
  const installation = Number(id);

  // Asked again here: ten minutes passed, and a role can change in ten minutes.
  const role = await context.accounts.role(workspace, account);
  if (role === undefined || !can(role, 'manage-workspace')) return back(context, workspace, 'forbidden');
  if ((await context.accounts.suspension(workspace)) !== undefined) return back(context, workspace, 'suspended');

  const userToken = await context.app.userToken(code, `${context.publicUrl}${GITHUB_APP_CALLBACK}`);
  if (userToken === undefined) return back(context, workspace, 'failed');
  let reached: Awaited<ReturnType<GithubApp['reachedBy']>>;
  try {
    reached = await context.app.reachedBy(userToken, installation);
  } catch {
    return back(context, workspace, 'failed');
  }
  if (reached === undefined) return back(context, workspace, 'refused');

  const attached = await context.accounts.attachInstallation(workspace, {
    label: `${GITHUB_APP_LABEL_PREFIX}${reached.account}`,
    sealed: sealInstallation(installation, context.secretsKey),
    installation: installationFingerprint(installation, context.secretsKey),
  });

  return back(context, workspace, attached === undefined ? 'elsewhere' : 'connected');
}
