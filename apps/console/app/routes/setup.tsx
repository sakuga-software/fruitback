import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { type Me, type Site, type Workspace, call, myInvitations, saveLanguage } from '../api';
import { adoptLanguage, t } from '../i18n';
import { InstallOptions } from '../install-options';
import { type SetupCalls, type Stage, firstWorkspace, leaveFor, resolveStage, siteStage } from '../setup-stage';
import { BrowserFrame, Button, EntryPage, Lead, Step, type StepState, Steps, Title } from '../ui';
import { useLocale } from '../use-locale';
import { Account, Ask, Sent, Unnamed } from './setup-account';
import { SiteForm, SiteSummary } from './setup-site';

/**
 * The setup, on one screen (FRU-239, screen 01 of the mockup of 2026-10-13): « Your account »,
 * « Your site », « Put it on the site ». The three steps show together; one that is done is a
 * summary, and opens again.
 *
 * Nobody names a workspace here: it takes its name from the address of the person
 * (`workspace-name.ts`), and « Rename » changes it. The choice of a tracker is not a step any more:
 * it is in Connectors, after.
 */

// `InstallOptions` moved to its own module. The Sites screen still reads it from here.
export { InstallOptions };

const SITE = 'https://fruitback.com';

/** What the setup asks of the worker, and the lock of the browser. Where it goes: `setup-stage.ts`. */
const CALLS: SetupCalls = {
  // Quiet: a person who is not signed in gets the first step, not the notice of a session that ended.
  me: () => call<Me>('GET', '/console/me', undefined, { quiet: true }),
  invitations: myInvitations,
  sites: (workspace) => call<{ sites: Site[] }>('GET', `/console/workspaces/${workspace.id}/sites`),
  createWorkspace: (name) => call<Workspace>('POST', '/console/workspaces', { name }),
  // No lock outside a secure context (`http` on a host other than localhost): two tabs can then each
  // make one. docs/decisions/console.md says so.
  alone: (task) =>
    typeof navigator === 'undefined' || navigator.locks === undefined
      ? task()
      : navigator.locks.request('fruitback:first-workspace', task),
};

/** The state of a step whose step before is in `before`: the one to do now, or one to come. */
function stepAfter(before: StepState): StepState {
  return before === 'done' ? 'current' : 'pending';
}

let resolving: Promise<Stage> | undefined;

/**
 * WARNING: one resolution at a time in this tab. It can make the first workspace, and two
 * resolutions in flight would ask for it twice.
 */
function resolveOnce(): Promise<Stage> {
  resolving ??= resolveStage(CALLS, (me) => adoptLanguage(me.account, saveLanguage)).finally(() => {
    resolving = undefined;
  });

  return resolving;
}

export default function Setup() {
  useLocale();
  const navigate = useNavigate();
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  // Kept above the stages: « Use another address » gives the form back with the address in it.
  const [email, setEmail] = useState('');

  useEffect(() => {
    let live = true;
    void resolveOnce().then((resolved) => {
      if (live) setStage(resolved);
    });

    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const away = leaveFor(stage);
    if (away !== undefined) void navigate(away, { replace: true });
  }, [stage, navigate]);

  // The title of the tab, as the mockup names it. The cleanup gives back the name of the product.
  useEffect(() => {
    const before = document.title;
    document.title = t('Set up Fruitback');

    return () => {
      document.title = before;
    };
  });

  const account = 'account' in stage ? stage.account : undefined;
  const workspace = 'workspace' in stage ? stage.workspace : undefined;
  // The first step is to do until somebody is signed in and has a workspace; the last one is the
  // current one once a site is there.
  const signedIn = account !== undefined && stage.kind !== 'unnamed';
  const installing = stage.kind === 'install';
  const first: StepState = signedIn ? 'done' : 'current';
  const second: StepState = installing ? 'done' : stepAfter(first);
  const third: StepState = installing ? 'current' : 'pending';
  const prefix = t('Current step:');

  return (
    <EntryPage
      width="full"
      aside={
        <p>
          {t('Running your own server?')}{' '}
          <a
            href={`${SITE}/self-hosting.html`}
            className="text-ink underline decoration-1 underline-offset-3 hover:text-accent-strong"
          >
            {t('Self-hosting guide')}
          </a>
        </p>
      }
    >
      <section aria-labelledby="setup-title" className="max-w-135 min-w-0 flex-1 basis-100">
        <div id="setup-title" className="mb-2">
          <Title size="setup">{t('Set up Fruitback')}</Title>
        </div>
        <Lead className="mb-9">{t('Three steps to your first note on a live page. Hosted in Europe.')}</Lead>

        <Steps>
          <Step state={first} number={1} title={t('Your account')} currentPrefix={prefix}>
            {stage.kind === 'loading' ? <p aria-busy="true" /> : null}
            {stage.kind === 'email' ? (
              <Ask email={email} onEmail={setEmail} onSent={(sent) => setStage({ kind: 'sent', email: sent })} />
            ) : null}
            {stage.kind === 'sent' ? (
              <Sent
                email={stage.email}
                onBack={() => setStage({ kind: 'email' })}
                // Signed in from another tab: the same resolution as a visit.
                onSignedIn={() => void resolveOnce().then(setStage)}
              />
            ) : null}
            {stage.kind === 'unchecked' ? (
              <div className="mt-3 flex flex-col items-start gap-3">
                <p role="alert" className="text-body text-muted">
                  {t('Fruitback did not answer. Try again.')}
                </p>
                <Button tone="outline" onClick={() => void resolveOnce().then(setStage)}>
                  {t('Try again')}
                </Button>
              </div>
            ) : null}
            {stage.kind === 'unnamed' ? (
              <Unnamed
                account={stage.account}
                tried={stage.problem}
                make={(name) => firstWorkspace(CALLS, stage.account, name)}
                onCreated={(made) => void siteStage(CALLS, stage.account, made).then(setStage)}
              />
            ) : null}
            {account !== undefined && workspace !== undefined ? (
              <Account
                account={account}
                workspace={workspace}
                onRenamed={(renamed) => setStage((now) => ('workspace' in now ? { ...now, workspace: renamed } : now))}
              />
            ) : null}
          </Step>

          <Step state={second} number={2} title={t('Your site')} currentPrefix={prefix}>
            {second === 'pending' ? (
              <p className="mt-0.5 text-small text-muted">{t('The address you review.')}</p>
            ) : null}
            {stage.kind === 'unread' ? (
              <div className="mt-3 flex flex-col items-start gap-3">
                <p role="alert" className="text-body text-muted">
                  {t('Fruitback did not answer. Your sites are not lost.')}
                </p>
                <Button
                  tone="outline"
                  onClick={() => void siteStage(CALLS, stage.account, stage.workspace).then(setStage)}
                >
                  {t('Try again')}
                </Button>
              </div>
            ) : null}
            {stage.kind === 'site' ? (
              <SiteForm
                workspace={stage.workspace}
                replaces={stage.replaces}
                onDone={(added) =>
                  setStage({ kind: 'install', account: stage.account, workspace: stage.workspace, ...added })
                }
              />
            ) : null}
            {stage.kind === 'install' ? (
              <SiteSummary
                workspace={stage.workspace}
                site={stage.site}
                left={stage.left}
                onChange={() =>
                  setStage({
                    kind: 'site',
                    account: stage.account,
                    workspace: stage.workspace,
                    replaces: { site: stage.site, ...(stage.fresh === true ? { fresh: true } : {}) },
                  })
                }
              />
            ) : null}
          </Step>

          <Step state={third} number={3} title={t('Put it on the site')} currentPrefix={prefix}>
            {stage.kind === 'install' ? (
              // No `items-start` here: the script would take the width of its longest line, and the page
              // would scroll sideways. It scrolls in its own box.
              <div className="mt-3 flex min-w-0 flex-col gap-5">
                <InstallOptions workspace={stage.workspace} site={stage.site} />
                <div>
                  <Button to={`/w/${stage.workspace.id}/sites`}>{t('Finish')}</Button>
                </div>
              </div>
            ) : (
              <p className="mt-0.5 text-small text-muted">{t('The extension, or a script tag.')}</p>
            )}
          </Step>
        </Steps>
      </section>

      <section aria-label={t('Preview of your site')} className="min-w-0 flex-999 basis-130">
        <BrowserFrame
          address={stage.kind === 'install' ? new URL(stage.site.origin).host : t('your site')}
          // Once the site is added the sentence would be false, and the picture of it comes with the
          // last step (FRU-242): the frame stays, with its drop.
          empty={stage.kind === 'install' ? '' : t('Your site shows here once you add it, with its pins.')}
          caption={t('A preview of your site. Pins show the same way on the real page.')}
        />
      </section>
    </EntryPage>
  );
}
