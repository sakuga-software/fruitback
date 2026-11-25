import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { type Connector, type Destination, type Site, placesOf, setPlaces } from '../api';
import { ConnectorMark, type MarkedKind } from '../connector-marks';
import { msg, t } from '../i18n';
import { type Listed } from '../listed';
import { writeProblemOf } from '../problems';
import { siteLabel, siteName } from '../site-address';
import { STAGES } from '../stages';
import { Button, Chip, Menu, Problem, StatusBar } from '../ui';
import { useLocale } from '../use-locale';
import { notesOf } from '../routes/sites';
import { SiteIcon, type SiteIconName } from './site-icons';
import { siteTabPath } from './site-tabs';

/**
 * The tab « Overview » of a site (FRU-689), as the mockup « Un site » draws it: three figures, the card
 * « Site » in rows of 44 px, and the card « Where the notes go » with the logo of each place. Each
 * figure is one the worker gives today (`GET …/sites/<id>`): no figure is drawn that it does not.
 */

/** A card of the overview: a head of 44 px with its title and its actions, then its rows. */
export function OverviewCard({
  id,
  title,
  label,
  actions,
  children,
}: {
  /** The id of the title: the card is a region named by it, or by `label`. */
  id: string;
  title: string;
  label?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      {...(label === undefined ? { 'aria-labelledby': id } : { 'aria-label': label })}
      className="overflow-hidden rounded-card border border-line bg-surface"
    >
      <div className="flex min-h-[44px] items-center gap-[8px] px-[16px]">
        <h2 id={id} className="min-w-0 text-small leading-auto font-semibold">
          {title}
        </h2>
        {actions === undefined ? null : <span className="ms-auto flex items-center gap-[8px]">{actions}</span>}
      </div>
      {children}
    </section>
  );
}

/** One figure: its name, its value at 20 px, and a line or a bar under it. */
function Figure({ name, value, children }: { name: string; value: string; children?: ReactNode }) {
  return (
    <div data-figure className="flex min-w-0 flex-col gap-[6px] rounded-card border border-line px-[16px] py-[14px]">
      <span className="text-hint text-muted">{name}</span>
      <span className="text-title leading-none font-semibold tabular-nums">{value}</span>
      {children === undefined ? null : (
        <span className="flex min-h-[12px] items-center text-hint text-muted">{children}</span>
      )}
    </div>
  );
}

/**
 * The three figures of a site: its notes, with the bar of their statuses; the new ones, and how many
 * are to do or in progress; and how many went to its tracker, for whoever sees the tracker.
 *
 * « Delivered » is the share of the notes that no tracker is still waiting for (`undelivered`, REST,
 * FRU-122). The worker counts no note by day yet: the figure is of every note, not of 30 days.
 */
export function SiteFigures({ workspace, site, seesTracker }: { workspace: string; site: Site; seesTracker: boolean }) {
  useLocale();
  const notes = site.notes;
  const total = notes === undefined ? undefined : STAGES.reduce((sum, stage) => sum + notes[stage], 0);
  const none = '·';
  let bar: ReactNode;
  if (notes !== undefined && total !== undefined)
    bar =
      total === 0 ? (
        t('Waiting for the first note')
      ) : (
        <StatusBar
          width="short"
          counts={notes}
          label={
            total === 1
              ? t('1 note: {new} new, {todo} to do, {progress} in progress, {done} done, {closed} closed', notes)
              : t('{count} notes: {new} new, {todo} to do, {progress} in progress, {done} done, {closed} closed', {
                  count: total,
                  ...notes,
                })
          }
        />
      );
  let fresh = none;
  if (notes !== undefined) fresh = notes.new === 1 ? t('1 new') : t('{count} new', { count: notes.new });

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(160px,100%),1fr))] gap-[12px]">
      <Figure name={t('Notes')} value={total === undefined ? none : String(total)}>
        {bar}
      </Figure>
      <Figure name={t('Open')} value={fresh}>
        {notes === undefined ? undefined : t('{count} to do or in progress', { count: notes.todo + notes.progress })}
      </Figure>
      {seesTracker ? <Delivered workspace={workspace} site={site} total={total} /> : null}
    </div>
  );
}

function Delivered({ workspace, site, total }: { workspace: string; site: Site; total: number | undefined }) {
  useLocale();
  if (placesOf(site).length === 0)
    return (
      <Figure name={t('Delivered')} value={t('In Fruitback')}>
        {t('No tracker for this site')}
      </Figure>
    );
  const late = site.undelivered;
  if (total === undefined || late === undefined) return <Figure name={t('Delivered')} value="·" />;
  if (total === 0)
    return (
      <Figure name={t('Delivered')} value="·">
        {t('No note yet')}
      </Figure>
    );
  // Down, so that one note still waiting is never « 100 % ».
  const share = Math.floor(((total - Math.min(late, total)) / total) * 100);

  return (
    <Figure name={t('Delivered')} value={t('{share} %', { share })}>
      {late === 0 ? (
        t('Nothing waiting to be sent')
      ) : (
        <Link
          to={notesOf(workspace, site.id)}
          className="rounded-inner font-medium text-accent-strong underline-offset-[3px] hover:underline"
        >
          {late === 1 ? t('1 not delivered yet') : t('{count} not delivered yet', { count: late })}
        </Link>
      )}
    </Figure>
  );
}

/** A row of the card « Site »: its icon, its name, its value, and « Change » where it is changed. */
function SettingRow({
  icon,
  name,
  value,
  change,
}: {
  icon: SiteIconName;
  name: string;
  value: ReactNode;
  change?: { to: string; label: string };
}) {
  useLocale();

  return (
    <li
      data-site-row
      className="flex min-h-[44px] flex-wrap items-center gap-x-[12px] gap-y-[2px] border-t border-line px-[16px] py-[6px] text-small"
    >
      <span className="inline-flex text-muted">
        <SiteIcon name={icon} size={16} />
      </span>
      <span data-site-row-name className="w-[180px] max-w-[calc(100%-28px)] text-ink-soft">
        {name}
      </span>
      <span data-site-row-value className="min-w-[120px] flex-1 font-medium [overflow-wrap:anywhere]">
        {value}
      </span>
      {change === undefined ? null : (
        <Link
          to={change.to}
          aria-label={change.label}
          className="rounded-inner font-medium text-muted [text-decoration:none] hover:text-ink"
        >
          {t('Change')}
        </Link>
      )}
    </li>
  );
}

/**
 * The card « Site »: its address, who sees its notes, who leaves them, the e-mail of a note done where
 * anybody writes (FRU-604), and how the notes came. « Change » leads to the tab that changes each, for
 * an owner or an admin: « Access » for the first three (FRU-703), « Install » for the last.
 */
export function SiteRows({
  workspace,
  site,
  manages,
  writers,
  notifyDone,
}: {
  workspace: string;
  site: Site;
  manages: boolean;
  writers: 'anyone' | 'members';
  notifyDone: boolean;
}) {
  useLocale();
  const host = siteName(site.origin);
  const access = siteTabPath(workspace, site.id, 'access');
  const change = (label: string, to = access) => (manages ? { to, label } : undefined);

  return (
    <OverviewCard id="site-about" title={t('Site')}>
      <ul>
        <SettingRow icon="address" name={t('Address')} value={<SiteLink origin={site.origin} />} />
        <SettingRow
          icon="members"
          name={t('Who sees the notes')}
          value={site.visibility === 'members' ? t('Members only') : t('Everyone who visits')}
          change={change(t('Change who sees the notes of {site}', { site: host }))}
        />
        <SettingRow
          icon="notes"
          name={t('Who can leave a note')}
          value={writers === 'anyone' ? t('Anyone on the page') : t('Members only')}
          change={change(t('Change who can leave a note on {site}', { site: host }))}
        />
        {/* FRU-604: said only where anybody may leave a note, as the switch is shown only there. */}
        {writers === 'anyone' ? (
          <SettingRow
            icon="mail"
            name={t('E-mail when a note is done')}
            value={notifyDone ? t('Offered to visitors') : t('Off')}
            change={change(t('Change the e-mail when a note of {site} is done', { site: host }))}
          />
        ) : null}
        <SettingRow
          icon="extension"
          name={t('On the page with')}
          value={site.via === undefined || site.via.length === 0 ? t('None yet') : viaOf(site.via)}
          change={{
            to: siteTabPath(workspace, site.id, 'install'),
            label: t('Change how Fruitback is on {site}', { site: host }),
          }}
        />
      </ul>
    </OverviewCard>
  );
}

/** How the notes of a site came: the script pasted on its pages, the extension, or both. */
export function viaOf(via: readonly ('script' | 'extension')[]): string {
  if (via.includes('script') && via.includes('extension')) return t('Extension and script');

  return via.includes('extension') ? t('Extension') : t('Script');
}

/**
 * The address of the site, a link to it in a new tab (FRU-575): the console stays where it is. Only an
 * `http` or `https` origin is a link, to the address it shows; the worker keeps no other.
 */
function SiteLink({ origin }: { origin: string }) {
  useLocale();
  const label = siteLabel(origin);
  if (!/^https?:\/\//.test(label)) return <span className="[overflow-wrap:anywhere]">{label}</span>;

  return (
    <a
      href={label}
      target="_blank"
      rel="noreferrer"
      className="[overflow-wrap:anywhere] text-ink underline decoration-1 underline-offset-[3px] hover:text-accent-strong"
    >
      {label}
      <span className="sr-only"> {t('(opens in a new tab)')}</span>
    </a>
  );
}

/** The trackers whose name the worker writes first in the label of a place: « Linear · Web ». */
const KIND_OF_NAME: Readonly<Record<string, MarkedKind>> = { Linear: 'linear', GitHub: 'github', 'REST API': 'rest' };

/** The kind of a place: its source's, or the one its label names while the sources are read. */
function kindOf(place: Destination, sources: readonly Connector[]): MarkedKind | undefined {
  const source = sources.find((each) => each.id === place.connector);
  if (source !== undefined) return source.kind as MarkedKind;
  const named = place.label?.split(' · ')[0] ?? '';

  return Object.hasOwn(KIND_OF_NAME, named) ? KIND_OF_NAME[named] : undefined;
}

const PLACES_NOT_CHANGED = msg('The destinations of this site did not change. Try again.');

/**
 * The card « Where the notes go »: each place on a row of 48 px, the logo of its tracker (FRU-690) in
 * a box of 28 px, its name, « Default » on the first, and a menu: « Make it the default », « Remove ».
 * « Add » leads to the tab « Destinations », which searches the places of every source.
 *
 * WARNING: the list is written whole (FRU-123), with the kind of each source: the menu waits while a
 * list is written, and until the sources are read.
 */
export function PlacesCard({
  base,
  workspace,
  site,
  connectors,
  onPlaced,
}: {
  base: string;
  workspace: string;
  site: Site;
  connectors: Listed<Connector>;
  onPlaced: (places: Destination[]) => void;
}) {
  useLocale();
  const [writing, setWriting] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const places = placesOf(site);
  const sources = typeof connectors === 'string' ? [] : connectors;
  const blocked = writing || typeof connectors === 'string';
  const host = siteName(site.origin);

  async function place(next: Destination[]) {
    if (blocked) return;
    setWriting(true);
    setProblem(undefined);
    const set = await setPlaces(base, site, next, sources);
    if (set.ok) {
      const kept = (set.data as { destinations?: Destination[] } | undefined)?.destinations;
      onPlaced(Array.isArray(kept) ? kept : next);
    } else setProblem(writeProblemOf(set, PLACES_NOT_CHANGED));
    setWriting(false);
  }

  return (
    <OverviewCard
      id="site-places"
      title={t('Where the notes go')}
      actions={
        <Button
          tone="outline"
          size="small"
          inset={10}
          gap={6}
          to={siteTabPath(workspace, site.id, 'destinations')}
          label={t('Add a destination for {site}', { site: host })}
        >
          <SiteIcon name="add" />
          {t('Add')}
        </Button>
      }
    >
      {places.length === 0 ? (
        <p className="border-t border-line px-[16px] py-[14px] text-small text-muted">
          {t('Its notes stay in Fruitback, in this workspace.')}
        </p>
      ) : (
        <ol aria-label={t('Destinations of {site}', { site: host })}>
          {places.map((each, index) => {
            const kind = kindOf(each, sources);
            const name = each.label ?? t('A tracker');
            const rest = places.filter((_, position) => position !== index);

            return (
              <li
                key={[each.connector, each.teamId ?? '', each.projectId ?? ''].join('|')}
                data-place
                className="flex min-h-[48px] items-center gap-[12px] border-t border-line px-[16px] py-[8px] text-small"
              >
                <span className="inline-flex size-[28px] flex-none items-center justify-center rounded-control border border-line bg-surface text-ink-soft">
                  {kind === undefined ? null : <ConnectorMark kind={kind} />}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                  <span className="font-semibold [overflow-wrap:anywhere]">{name}</span>
                  {each.attention === undefined ? null : (
                    <span className="text-hint font-semibold text-accent-strong">{t('Needs attention')}</span>
                  )}
                </span>
                {index === 0 ? <Chip>{t('Default')}</Chip> : null}
                <Menu
                  trigger="icon"
                  triggerLabel={t('Actions of {place}', { place: name })}
                  items={[
                    ...(index === 0 ? [] : [{ id: 'default', label: t('Make it the default'), disabled: blocked }]),
                    { id: 'remove', label: t('Remove'), danger: true, disabled: blocked },
                  ]}
                  onAction={(id) => void place(id === 'default' ? [each, ...rest] : rest)}
                >
                  <SiteIcon name="more" size={16} />
                </Menu>
              </li>
            );
          })}
        </ol>
      )}
      {problem === undefined ? null : (
        <div className="border-t border-line px-[16px] py-[12px]">
          <Problem>{t(problem)}</Problem>
        </div>
      )}
    </OverviewCard>
  );
}
