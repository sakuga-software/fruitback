import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { type Me, type Site, type Workspace, call, myInvitations, saveLanguage } from '../api';
import { adoptLanguage, t } from '../i18n';
import { InstallOptions } from '../install-options';
import { PreviewScene } from '../preview-scene';
import {
  type SetupCalls,
  type Stage,
  firstWorkspace,
  leaveFor,
  noted,
  resolveStage,
  siteNow,
  siteStage,
} from '../setup-stage';
import { BrowserFrame, Button, EntryPage, Lead, Step, type StepState, Steps, Title } from '../ui';
import { useLocale } from '../use-locale';
import { Account, Ask, Sent, Unnamed } from './setup-account';
import { PutDone, PutOnSite } from './setup-install';
import { SiteForm, SiteSummary } from './setup-site';
import { siteLabel } from '../site-address';

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

/** How often the site is read again while the setup waits for its first note (FRU-242). */
export const FIRST_NOTE_EVERY_MS = 5_000;

/**
 * Reads the site again every five seconds while the tab is shown, until its first note came: the
 * step then is done, by itself. A hidden tab asks nothing, and asks again when it is shown. A read
 * that fails changes nothing, and the next one is made at its time.
 */
function useFirstNote(stage: Stage, setStage: Dispatch<SetStateAction<Stage>>): void {
  const waiting = stage.kind === 'install' && !noted(stage.site) ? stage : undefined;
  useEffect(() => {
    if (waiting === undefined) return;
    const { workspace, site } = waiting;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let asking = false;
    let stopped = false;
    const schedule = () => {
      if (stopped || asking || timer !== undefined || document.visibilityState !== 'visible') return;
      timer = setTimeout(() => void ask(), FIRST_NOTE_EVERY_MS);
    };
    const ask = async () => {
      timer = undefined;
      if (document.visibilityState !== 'visible') return;
      asking = true;
      const now = await siteNow(CALLS, workspace, site);
      asking = false;
      if (stopped) return;
      if (now !== undefined && noted(now)) {
        return setStage((current) =>
          current.kind === 'install' && current.site.id === now.id ? { ...current, site: now } : current,
        );
      }
      schedule();
    };
    document.addEventListener('visibilitychange', schedule);
    schedule();

    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [waiting, setStage]);
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

  useFirstNote(stage, setStage);

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
  // The first step is to do until somebody is signed in and has a workspace: invitations that could
  // not be read, or a workspace that was not made, keep it current. The last one is the current one
  // once a site is there.
  const signedIn = account !== undefined && workspace !== undefined;
  const installing = stage.kind === 'install';
  const first: StepState = signedIn ? 'done' : 'current';
  const second: StepState = installing ? 'done' : stepAfter(first);
  // The setup ends at the first note on the site: the last step is done then, by itself.
  const finished = stage.kind === 'install' && noted(stage.site);
  let third: StepState = installing ? 'current' : 'pending';
  if (finished) third = 'done';
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
            {stage.kind === 'install' && finished ? <PutDone site={stage.site} /> : null}
            {stage.kind === 'install' && !finished ? <PutOnSite workspace={stage.workspace} site={stage.site} /> : null}
            {stage.kind === 'install' ? null : (
              <p className="mt-0.5 text-small text-muted">{t('The extension, or a script tag.')}</p>
            )}
          </Step>
        </Steps>
        {stage.kind === 'install' && finished ? (
          // Said once it appears, with no move of the focus: the person may be on the site, in another tab.
          <div role="status" className="mt-9 flex flex-col gap-2.5 border-t border-line pt-7">
            <h2 className="text-conclusion font-bold tracking-[-0.01em]">{t('Your first note is in')}</h2>
            <p className="text-body leading-[1.55] text-muted">
              {t(
                'It waits in the {workspace} workspace. Send your notes to Linear or your own API whenever you like.',
                {
                  workspace: stage.workspace.name,
                },
              )}
            </p>
            <div className="mt-2 flex flex-wrap gap-2.5">
              <Button inset={22} to={`/w/${stage.workspace.id}/sites`}>
                {t('Open the console')}
              </Button>
              <Button tone="outline" size="page" inset={18} to={`/w/${stage.workspace.id}/connectors`}>
                {t('Connect a tracker')}
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      <section aria-label={t('Preview of your site')} className="min-w-0 flex-999 basis-130">
        {stage.kind === 'install' ? (
          <BrowserFrame
            address={siteLabel(stage.site.origin)}
            // A picture of an example page, not the site of the person: the caption says so.
            caption={t('An example page. Pins show the same way on your site.')}
          >
            <PreviewScene
              launch={t('Leave feedback')}
              hint={t('Click Leave feedback, then any part of the page.')}
              {...(finished
                ? {
                    note: {
                      status: t('New'),
                      text: 'The headline runs to three lines on a phone. Could it be shorter?',
                      by: t('{name} · just now', {
                        name: stage.account.name ?? stage.account.email.split('@')[0] ?? '',
                      }),
                    },
                  }
                : {})}
            />
          </BrowserFrame>
        ) : (
          <BrowserFrame
            address={t('your site')}
            empty={t('Your site shows here once you add it, with its pins.')}
            caption={t('A preview of your site. Pins show the same way on the real page.')}
          />
        )}
      </section>
    </EntryPage>
  );
}
