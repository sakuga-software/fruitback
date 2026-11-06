import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  type AdminWorkspace,
  type AdminWorkspaceDetail,
  type WorkspaceSuspension,
  adminWorkspace,
  adminWorkspaces,
} from '../api';
import { msg, t } from '../i18n';
import { Button, DataTable, PageHead, Problem } from '../ui';
import { useLocale } from '../use-locale';
import { useWide } from '../wide';
import { SuspendedSince } from './admin-instance';
import { Cut, ListBar, NoRows, RowLink, UnderRow, rowId, useListAddress, useRead } from '../parts/admin-list';
import { ReadProblem } from '../read-problem';
import { Alert, Notes, goesTo, ownersOf, sizeOf, withoutSuspension } from '../parts/admin-workspace-facts';
import { Panel } from '../parts/admin-workspace-panel';
import { NewWorkspace, Saying, saying } from '../parts/admin-workspace-writes';

/**
 * The workspaces of the instance, as screen 18 of the mockup of 2026-10-13 draws them (FRU-263):
 * who owns each one, its notes, and where they go. « Delete the workspace » in the foot of a panel
 * deletes it after its name is typed (FRU-284). « New workspace », and in a panel « Add someone »,
 * « Invite someone » and « Change the owner », write at once, and the owners read it (FRU-283).
 * « Suspend » in the foot of a panel, and « Restore » at the top of a suspended one, after a
 * confirmation (FRU-323, routes of FRU-282); a suspended workspace says so in its row, with the day.
 *
 * WARNING: each read writes a trace in each workspace of the answer that the administrator is not a
 * member of (FRU-261). The panel reads its workspace again, and leaves one more trace there.
 */

/** The filters of the worker (`WORKSPACE_FILTERS`), « Suspended » of the mockup included (FRU-328). */
const SHOW = [
  { value: 'all', label: msg('All workspaces') },
  { value: 'attention', label: msg('Needs a look') },
  { value: 'empty', label: msg('No site yet') },
  { value: 'suspended', label: msg('Suspended') },
] as const;

type Listed = { workspaces: AdminWorkspace[]; total: number };

/** The read of one workspace, with the id it answers, so that a panel never shows another one. */
type Read = { id: string; detail: AdminWorkspaceDetail | 'failed' } | 'none';

export default function AdminWorkspaces() {
  useLocale();
  const { q, show, open, typed, setTyped, change, openTo } = useListAddress();
  const wide = useWide();
  // Whether the panel that is about to appear was opened by a press of its row (FRU-197).
  const opening = useRef(false);

  const ask = useCallback(async (): Promise<Listed | 'failed'> => {
    const answer = await adminWorkspaces({ q, show });

    return answer.ok && Array.isArray(answer.data?.workspaces) ? answer.data : 'failed';
  }, [q, show]);
  const { shown, again, patch } = useRead(ask);
  // The name of the workspace that was just deleted: the page says it, where its row was.
  const [said, setSaid] = useState<Saying | undefined>();
  const statusLine = useRef<HTMLParagraphElement>(null);
  // Focus goes to the sentence: the panel or the form, and the button that had it, are gone.
  useEffect(() => {
    if (said !== undefined) statusLine.current?.focus();
  }, [said]);

  const rows = typeof shown === 'object' ? shown.workspaces : [];
  const chosen = rows.find((workspace) => workspace.id === open);
  // The page reads the chosen workspace, not its panel, and reads each one once: the panel moves
  // between two places at 1280 px, and each read leaves a trace with the owners.
  const chosenId = chosen?.id ?? '';
  const known = useRef(new Map<string, AdminWorkspaceDetail>());
  const askDetail = useCallback(async (): Promise<Read> => {
    if (chosenId === '') return 'none';
    const kept = known.current.get(chosenId);
    if (kept !== undefined) return { id: chosenId, detail: kept };
    const answer = await adminWorkspace(chosenId);
    if (!answer.ok || !Array.isArray(answer.data?.members)) return { id: chosenId, detail: 'failed' };
    known.current.set(chosenId, answer.data);

    return { id: chosenId, detail: answer.data };
  }, [chosenId]);
  const { shown: read, again: readAgain, patch: patchRead } = useRead(askDetail);
  const detail = typeof read === 'object' && read.id === chosenId ? read.detail : 'loading';
  const close = () => {
    change({ open: '' }, true);
    if (chosen !== undefined) document.getElementById(rowId(chosen.id))?.focus();
  };
  const panel =
    chosen === undefined ? null : (
      <Panel
        key={chosen.id}
        workspace={chosen}
        detail={detail}
        onRetry={readAgain}
        wide={wide}
        takesFocus={opening}
        onClose={close}
        onDeleted={(name) => {
          known.current.delete(chosen.id);
          setSaid(
            saying(msg('{workspace} was deleted. Every instance admin reads it on the page Instance.'), {
              workspace: name,
            }),
          );
          change({ open: '' }, true);
          again();
        }}
        onChanged={() => {
          // The detail is read again, and the row: an owner or a count of people changed.
          known.current.delete(chosen.id);
          readAgain();
          again();
        }}
        onSuspension={(state) => {
          // The row and the detail change in place, as a suspension of a person does (FRU-281): each
          // read leaves a trace with the owners, and the answer says the state.
          const id = chosen.id;
          const withState = <T extends WorkspaceSuspension>(each: T): T => ({ ...withoutSuspension(each), ...state });
          patch((listed) => ({
            ...listed,
            workspaces: listed.workspaces.map((each) => (each.id === id ? withState(each) : each)),
          }));
          const kept = known.current.get(id);
          if (kept !== undefined) known.current.set(id, withState(kept));
          patchRead((current) =>
            current !== 'none' && current.id === id && typeof current.detail === 'object'
              ? { id, detail: withState(current.detail) }
              : current,
          );
        }}
      />
    );

  return (
    <>
      <PageHead
        title={t('Workspaces')}
        lead={t('Every workspace on this instance, who owns it and where its notes go.')}
        className="mb-[8px]"
      />
      <p className="mb-[24px] max-w-[64ch] text-small text-muted">
        {t('The owners of each workspace see that you read its list, with your address and the day.')}
      </p>
      <div className="mb-[20px] max-w-[520px]">
        <NewWorkspace
          onMade={(made) => {
            setSaid(
              saying(msg('{workspace} was created, owned by {email}.'), {
                workspace: made.workspace.name,
                email: made.owner.email,
              }),
            );
            setTyped('');
            change({ q: '', show: 'all', open: made.workspace.id });
            again();
          }}
        />
      </div>
      {said === undefined ? null : (
        <p role="status" tabIndex={-1} ref={statusLine} className="mb-[16px] text-small font-semibold">
          {t(said.sentence, said.values)}
        </p>
      )}
      <ListBar
        label={t('Search workspaces')}
        placeholder={t('Search by name or owner')}
        typed={typed}
        onType={setTyped}
        show={show}
        onShow={(chosenShow) => change({ show: chosenShow })}
        options={SHOW.map((option) => ({ value: option.value, label: t(option.label) }))}
      />

      {shown === 'loading' ? <p className="text-small text-muted">{t('Loading…')}</p> : null}
      {shown === 'failed' ? (
        <div className="flex flex-col items-start gap-[12px]">
          <Problem>
            {t('The workspaces did not load.')} <ReadProblem />
          </Problem>
          <Button tone="outline" onClick={again}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}
      {typeof shown === 'object' && rows.length === 0 ? (
        <NoRows
          filtered={q !== '' || show !== 'all'}
          empty={t('No workspace on this instance yet.')}
          noMatch={t('No workspace matches this search.')}
          onClear={() => {
            setTyped('');
            change({ q: '', show: 'all', open: '' });
          }}
        />
      ) : null}

      {typeof shown === 'object' && rows.length > 0 ? (
        <div className="flex flex-wrap items-start gap-[28px]">
          <div className="min-w-0 flex-[999_1_560px]">
            <DataTable label={t('Workspaces of the instance')} minWidth={680} hover>
              <thead>
                <tr>
                  <th scope="col">{t('Workspace')}</th>
                  <th scope="col">{t('Owner')}</th>
                  <th scope="col">{t('Notes')}</th>
                  <th scope="col">{t('Notes go to')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((workspace) => {
                  const isChosen = workspace.id === chosen?.id;

                  return (
                    <Fragment key={workspace.id}>
                      <tr data-chosen={isChosen}>
                        <td>
                          <RowLink
                            id={workspace.id}
                            to={openTo(workspace.id)}
                            chosen={isChosen}
                            onOpen={() => (opening.current = true)}
                          >
                            {workspace.name}
                          </RowLink>
                          <span className="block text-hint text-muted tabular-nums">{sizeOf(workspace)}</span>
                          <SuspendedSince workspace={workspace} chosen={isChosen} />
                        </td>
                        <td className="[overflow-wrap:anywhere]">{ownersOf(workspace)}</td>
                        <td>
                          <Notes notes={workspace.notes} />
                        </td>
                        <td>
                          <span className="block">{goesTo(workspace.destinations)}</span>
                          <Alert workspace={workspace} chosen={isChosen} />
                        </td>
                      </tr>
                      {!wide && isChosen ? <UnderRow columns={4}>{panel}</UnderRow> : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </DataTable>
            <Cut
              shown={rows.length}
              total={shown.total}
              sentence={t('The first {count} of {total} workspaces.', { count: rows.length, total: shown.total })}
            />
          </div>
          {wide ? panel : null}
        </div>
      ) : null}
    </>
  );
}
