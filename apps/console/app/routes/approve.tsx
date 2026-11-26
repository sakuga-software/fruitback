import { useEffect, useState } from 'react';
import { call } from '../api';
import { ago } from '../ago';
import { msg, t } from '../i18n';
import { siteName } from '../site-address';
import { Button, Problem } from '../ui';
import { useLocale } from '../use-locale';
import { PageHead, useWorkspace } from './workspace';

/** One note of a visitor that waits for a member, as `GET …/held` answers it (FRU-704). */
export type HeldNote = {
  site: string;
  origin?: string;
  note: string;
  page: string;
  text: string;
  name?: string;
  heldAt: number;
};

const FAILED: Readonly<Record<string, string>> = {
  'place-gone': msg('The tracker no longer has the place of this site. The note still waits.'),
  'no-destination': msg('This site sends its notes nowhere yet. The note still waits.'),
  'store-unavailable': msg('The tracker did not answer. The note still waits: try again.'),
  'site-gone': msg('This site no longer takes notes. The note was removed.'),
};

/** What the screen says once a note was answered. */
function doneText(verb: 'approve' | 'reject', identifier: string | undefined): string {
  if (verb === 'reject') return t('Rejected. The note was removed.');
  if (identifier === undefined) return t('Approved. The note was sent.');

  return t('Approved. The note was sent as {identifier}.', { identifier });
}

/** The path of the page of a note, as the queue shows it: the address of the site is above it. */
function pathOf(page: string): string {
  try {
    const url = new URL(page);

    return `${url.pathname}${url.search}`;
  } catch {
    return page;
  }
}

/**
 * The queue « To approve » of a workspace (FRU-704): the notes of visitors that wait for a member, on
 * the sites that say « Hold new visitor notes » in their tab « Access ». « Approve » sends a note to
 * its place, as it would have gone at once; « Reject » removes it. A note waits 30 days at most.
 *
 * A guest has no such screen: the worker answers it `403`, and the bar shows it no entry.
 */
export default function Approve() {
  useLocale();
  const { workspace, approveCounted } = useWorkspace();
  const base = `/console/workspaces/${workspace.id}/held`;
  const [notes, setNotes] = useState<HeldNote[] | 'loading' | 'failed'>('loading');
  const [busy, setBusy] = useState<string | undefined>();
  const [said, setSaid] = useState<{ ok: boolean; text: string } | undefined>();
  const [asked, askAgain] = useState(0);

  useEffect(() => {
    let live = true;
    void call<{ notes: HeldNote[] }>('GET', base).then((answer) => {
      if (!live) return;
      if (!answer.ok) return setNotes('failed');
      setNotes(answer.data.notes);
      approveCounted(answer.data.notes.length);
    });

    return () => {
      live = false;
    };
  }, [base, asked]);

  async function answer(held: HeldNote, verb: 'approve' | 'reject') {
    const key = `${held.site}/${held.note}`;
    if (busy !== undefined) return;
    setBusy(key);
    setSaid(undefined);
    const done = await call<{ issue?: { identifier?: string } }>(
      'POST',
      `${base}/${held.site}/${encodeURIComponent(held.note)}/${verb}`,
    );
    setBusy(undefined);
    if (!done.ok) {
      const why = FAILED[done.error];
      setSaid({ ok: false, text: why === undefined ? t('The note did not change. Try again.') : t(why) });
      // The note is gone (another member answered it, or its site went), or waits again: read the queue.
      askAgain((count) => count + 1);

      return;
    }
    setSaid({ ok: true, text: doneText(verb, done.data?.issue?.identifier) });
    setNotes((current) => {
      if (!Array.isArray(current)) return current;
      const left = current.filter((each) => `${each.site}/${each.note}` !== key);
      approveCounted(left.length);

      return left;
    });
  }

  return (
    <>
      <PageHead
        title={t('To approve')}
        lead={t('Notes from visitors on the sites that hold them. Approve one to send it on, or reject it.')}
      />
      <div className="mt-[16px] flex flex-col gap-[12px]">
        {said?.ok === true ? (
          <p role="status" className="text-small text-muted">
            {said.text}
          </p>
        ) : null}
        {said?.ok === false ? <Problem>{said.text}</Problem> : null}
        {notes === 'loading' ? <p className="text-small text-muted">{t('Loading…')}</p> : null}
        {notes === 'failed' ? <Problem>{t('The notes to approve did not load. Try again.')}</Problem> : null}
        {Array.isArray(notes) && notes.length === 0 ? (
          <p className="text-small text-muted" data-approve-empty>
            {t('No note waits for approval.')}
          </p>
        ) : null}
        {Array.isArray(notes) && notes.length > 0 ? (
          <ul className="flex flex-col gap-[8px]" aria-label={t('Notes to approve')}>
            {notes.map((held) => {
              const key = `${held.site}/${held.note}`;
              const where = held.origin === undefined ? held.site : siteName(held.origin);

              return (
                <li
                  key={key}
                  className="flex flex-col gap-[8px] rounded-card border border-line bg-surface p-[12px] min-[700px]:flex-row min-[700px]:items-start"
                  data-held-note={held.note}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-[4px]">
                    <p className="text-(length:--text-hint) text-muted">
                      {where} · {pathOf(held.page)} · {held.name ?? t('A visitor')} ·{' '}
                      {ago(new Date(held.heldAt).toISOString())}
                    </p>
                    <p className="text-(length:--text-small) break-words whitespace-pre-wrap text-ink">{held.text}</p>
                  </div>
                  <div className="flex flex-none gap-[8px]">
                    <Button
                      size="small"
                      disabled={busy !== undefined}
                      label={t('Approve the note of {who}', { who: held.name ?? t('a visitor') })}
                      onClick={() => void answer(held, 'approve')}
                    >
                      {t('Approve')}
                    </Button>
                    <Button
                      tone="outline"
                      size="small"
                      disabled={busy !== undefined}
                      label={t('Reject the note of {who}', { who: held.name ?? t('a visitor') })}
                      onClick={() => void answer(held, 'reject')}
                    >
                      {t('Reject')}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </>
  );
}
