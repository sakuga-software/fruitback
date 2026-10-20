import { type FormEvent, useState } from 'react';
import { type Site, type Visibility, type Workspace, type Writers, call } from '../api';
import { t } from '../i18n';
import { SITE_NOT_ADDED, SITE_PROBLEMS, problemOf } from '../problems';
import { type Added, manages } from '../setup-stage';
import { siteAddress, siteLabel } from '../site-address';
import { Button, Field, LinkButton, Pick, Problem } from '../ui';
import { useLocale } from '../use-locale';
import { WritersPick } from '../writers-pick';

/** Step 2 of the setup, « Your site » (FRU-239): the form that adds it, and its summary. */

type SiteFormProps = {
  workspace: Workspace;
  /** The site this form changes: its values are in the form, and « Cancel » keeps it. */
  replaces?: Added | undefined;
  onDone: (added: Added) => void;
};

/**
 * Step 2: the address of the site, and who sees its notes.
 *
 * WARNING: the worker has no route that changes a site, and a site that is removed takes its notes
 * with it. So « Change » adds the site again with the new values, and removes the one it replaces
 * only when that one was added in this visit: nothing was noted on it yet. A site of a visit before
 * stays, the summary says so, and the Sites screen removes it with its two presses (FRU-165).
 */
export function SiteForm({ workspace, replaces, onDone }: SiteFormProps) {
  useLocale();
  const before = replaces?.site;
  const [url, setUrl] = useState(before === undefined ? '' : siteLabel(before.origin));
  const [visibility, setVisibility] = useState<Visibility>(before?.visibility ?? 'members');
  // A site of a worker of before has no `writers`: it takes a note from anybody (FRU-330).
  const [writers, setWriters] = useState<Writers>(before === undefined ? 'members' : (before.writers ?? 'anyone'));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setProblem(undefined);
    // The same reading as the Sites screen: a host with no scheme is https, or http when local (FRU-314).
    const address = siteAddress(url);
    if (address === undefined) return setProblem(SITE_PROBLEMS['invalid-url'] ?? SITE_NOT_ADDED);
    // Nothing changed: the site stays as it is, and nothing is asked of the worker.
    if (
      replaces !== undefined &&
      new URL(address).origin === before?.origin &&
      visibility === before.visibility &&
      (visibility !== 'members' || writers === (before.writers ?? 'anyone'))
    ) {
      return onDone(replaces);
    }
    setBusy(true);
    const base = `/console/workspaces/${workspace.id}/sites`;
    const added = await call<Site>('POST', base, {
      url: address,
      visibility,
      ...(visibility === 'members' ? { writers } : {}),
    });
    if (!added.ok) {
      setBusy(false);

      // No failure clears the field: the address stays as it was typed.
      return setProblem(problemOf(added, SITE_PROBLEMS, SITE_NOT_ADDED));
    }
    const removed =
      before !== undefined && replaces?.fresh === true && (await call('DELETE', `${base}/${before.id}`)).ok;
    setBusy(false);
    onDone({ site: added.data, fresh: true, ...(before === undefined || removed ? {} : { left: before }) });
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="mt-3 flex flex-col gap-5">
      <Field
        label={t('Site address')}
        inputMode="url"
        autoComplete="url"
        placeholder="staging.acme.dev"
        // A pattern such as *.preview.acme.dev is not said here: a preview is covered by a domain
        // that is proven (FRU-103), and the worker takes no pattern as an address.
        hint={t('Any page of it will do.')}
        value={url}
        onChange={(event) => setUrl(event.target.value)}
      />
      <Pick
        label={t('Who sees the notes?')}
        value={visibility}
        onChange={setVisibility}
        options={[
          {
            value: 'members',
            label: t('Members of {workspace}', { workspace: workspace.name }),
            detail: t("Visitors of the site see nothing. Right for staging and for a client's site."),
          },
          {
            value: 'everyone',
            label: t('Everyone who visits'),
            detail: t('A public way to report a problem on a live site.'),
          },
        ]}
      />
      <WritersPick visibility={visibility} value={writers} onChange={setWriters} />
      {problem === undefined ? null : <Problem>{t(problem)}</Problem>}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
        <Button type="submit" disabled={busy}>
          {replaces === undefined ? t('Add site') : t('Save')}
        </Button>
        {replaces === undefined ? null : (
          <LinkButton space="loose" onClick={() => onDone(replaces)}>
            {t('Cancel')}
          </LinkButton>
        )}
      </div>
    </form>
  );
}

/** Step 2, done: the site, who sees its notes, and « Change ». */
export function SiteSummary({
  workspace,
  site,
  left,
  onChange,
}: {
  workspace: Workspace;
  site: Site;
  left: Site | undefined;
  onChange: () => void;
}) {
  useLocale();

  return (
    <div className="mt-1.5 flex flex-col gap-1 text-body">
      {/* A long host takes the lines it needs: the page does not scroll sideways (FRU-159). */}
      <p className="font-semibold wrap-anywhere">{siteLabel(site.origin)}</p>
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-muted">
        {site.visibility === 'members'
          ? t('Members of {workspace} see the notes', { workspace: workspace.name })
          : t('Everyone who visits sees the notes')}
        {/* FRU-330: the exception only, as on the Sites screen. */}
        {site.visibility === 'members' && site.writers === 'anyone' ? (
          <span>{t('Notes from anyone on the page')}</span>
        ) : null}
        {manages(workspace) ? (
          <LinkButton space="flush" onClick={onChange}>
            {t('Change')}
          </LinkButton>
        ) : null}
      </p>
      {left === undefined ? null : (
        <p role="status" className="text-hint text-muted">
          {t('{site} is still in your sites, with its notes. Remove it in Sites if you no longer review it.', {
            site: siteLabel(left.origin),
          })}
        </p>
      )}
    </div>
  );
}
