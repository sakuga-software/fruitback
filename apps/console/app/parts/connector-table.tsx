import { type Connector, type Site, placesOf } from '../api';
import { t } from '../i18n';
import { Button, DataTable, IconButton } from '../ui';
import { useLocale } from '../use-locale';
import { ConnectorLogo } from '../connector-logos';
import { NoteIcon } from '../note-icons';
import { ago } from '../ago';
import { KINDS, connectorName, siteCount, sourceLine } from './connector-parts';
import { Health, type Late, receives } from './connector-health';

/** The account of a source, in its row: its kind first when a name hides it (FRU-404). */
function lineOf(connector: Connector): string {
  return connector.name === undefined
    ? sourceLine(connector)
    : `${t(KINDS[connector.kind].name)} · ${sourceLine(connector)}`;
}

/**
 * « Used by » (FRU-714): the sites that send there, and the notes that went there when the worker
 * counted them: « 2 sites · 31 notes ». A routine is no place for notes (FRU-594): nothing.
 */
function usedBy(connector: Connector, sites: readonly Site[] | undefined): string | undefined {
  if (sites === undefined || connector.kind === 'claude-routine') return undefined;
  const notes = connector.health?.notes;
  if (notes === undefined) return siteCount(sites.length);

  return `${siteCount(sites.length)} · ${notes === 1 ? t('1 note') : t('{count} notes', { count: notes })}`;
}

/**
 * « Last delivery » (FRU-714): how long ago the last send arrived, « None yet » before the first, and
 * nothing for a worker that says no health.
 */
function LastDelivery({ connector }: { connector: Connector }) {
  useLocale();
  const at = connector.health?.lastDeliveredAt;
  if (connector.health === undefined) return null;
  if (at === undefined) return t('None yet');

  return <time dateTime={at}>{ago(at)}</time>;
}

/**
 * The classes of a part of a row where the table is a stack of cards (FRU-727): `DataTable` writes
 * `data-stacked` on its frame. The kit draws a stacked row as a column of cells, with selectors that
 * name the frame, so a value that the kit also sets here is `!important`.
 */
const STACKED = {
  // A card: the logo at its left, and its lines beside it, which go to the next line when they are long.
  row: '[[data-stacked=true]_&]:relative [[data-stacked=true]_&]:flex-row! [[data-stacked=true]_&]:flex-wrap [[data-stacked=true]_&]:items-center [[data-stacked=true]_&]:gap-x-0! [[data-stacked=true]_&]:gap-y-[4px]! [[data-stacked=true]_&]:pl-[64px]!',
  // The name on the first line, beside « … »; the logo, out of the line, at the left of the card.
  name: '[[data-stacked=true]_&]:order-1 [[data-stacked=true]_&]:basis-full [[data-stacked=true]_&]:pr-[36px]! [[data-stacked=true]_&>span>span[aria-hidden]]:absolute [[data-stacked=true]_&>span>span[aria-hidden]]:top-[14px] [[data-stacked=true]_&>span>span[aria-hidden]]:left-[20px] [[data-stacked=true]_&>span>span[aria-hidden]]:size-[32px]! [[data-stacked=true]_&>span>span[aria-hidden]>*]:size-[16px]!',
  account:
    '[[data-stacked=true]_&]:order-2 [[data-stacked=true]_&]:basis-full [[data-stacked=true]_&]:pr-[36px]! [[data-stacked=true]_&]:text-small',
  health: '[[data-stacked=true]_&]:order-3 [[data-stacked=true]_&]:mr-[8px] [[data-stacked=true]_&]:flex-none',
  // « 2 sites · 31 notes · 12 min ago »: the sites and notes, a dot, then the last delivery. The dot
  // ends the sites: a line that is too long goes on with the time, never with a dot.
  usedBy: '[[data-stacked=true]_&]:order-4 [[data-stacked=true]_&]:text-small [[data-stacked=true]_&>*]:inline!',
  dot: "[[data-stacked=true]_&]:after:mx-[4px] [[data-stacked=true]_&]:after:content-['·']",
  last: '[[data-stacked=true]_&]:order-5 [[data-stacked=true]_&]:text-small',
  // « Retry » on a line of its own, at the right; « … » at the top right of the card.
  actions:
    '[[data-stacked=true]_&]:order-6 [[data-stacked=true]_&]:basis-full [[data-stacked=true]_&]:pt-[6px]! [[data-stacked=true]_&>span]:flex [[data-stacked=true]_&>span]:justify-end',
  // No « Retry »: the cell takes no line, and only « … » shows, at the top right.
  alone: '[[data-stacked=true]_&]:absolute [[data-stacked=true]_&]:top-[10px] [[data-stacked=true]_&]:right-[12px]',
  more: '[[data-stacked=true]_&]:absolute [[data-stacked=true]_&]:top-[10px] [[data-stacked=true]_&]:right-[12px]',
} as const;

/**
 * « Used by » goes where the table is narrower than 900 px (FRU-727, the tablet of the mockup): its
 * column is 0 px wide, and its head is said to a screen reader only, as the Sites table does. A card
 * says it again, on the line of the health.
 */
const USED_BY_COLUMN = '@max-[900px]:w-0';
const USED_BY_CELL = '@max-[900px]:px-0! @max-[900px]:[&>*]:hidden';
const USED_BY_HEAD = '@max-[900px]:px-0! @max-[900px]:[&>*]:sr-only';

/**
 * A press of a finger reaches a control of 44 px (FRU-727): « … » and « Retry » take presses around
 * their box (a small control is 24 px), and they stand 20 px apart, so that the two areas do not meet.
 */
const TOUCH =
  'pointer-coarse:[&_button]:relative pointer-coarse:[&_button]:after:absolute pointer-coarse:[&_button]:after:-inset-[10px] pointer-coarse:gap-[20px]!';

/**
 * The table « Your connectors » (FRU-690): a row for each connector, with its logo and its name, its
 * account, the sites that use it and its notes, its health, when its last send arrived (FRU-714),
 * « Retry » when its sends wait, and « … » that opens its settings. Under 900 px « Used by » goes; under
 * 680 px each row is a card (`DataTable` with `stack`): the logo, the name and « … », the account,
 * then the health, the sites and the last delivery, and « Retry » on a line of its own (FRU-727).
 */
export function ConnectorsTable({
  connectors,
  selected,
  sites,
  late,
  manages,
  retrying,
  onRetry,
  onOpen,
}: {
  connectors: readonly Connector[];
  /** The connector whose settings are open: its row keeps the tint of a chosen row. */
  selected: string | undefined;
  /** The sites of the workspace, when they were read. */
  sites: readonly Site[] | undefined;
  /** What waits for each connector that receives, when it was read. */
  late: Readonly<Record<string, Late>>;
  manages: boolean;
  /** The connector whose sends « Retry » asks again now. */
  retrying: string | undefined;
  onRetry: (connector: Connector, ids: readonly string[]) => void;
  onOpen: (connector: string) => void;
}) {
  useLocale();
  /** The sites that send to a connector, from a list that was read. */
  const sitesOf = (connector: Connector): readonly Site[] | undefined =>
    sites?.filter((site) => placesOf(site).some((place) => place.connector === connector.id));

  return (
    // The container whose width the columns follow (FRU-727).
    <div className="@container">
      <DataTable label={t('Your connectors')} minWidth={680} dense hover stack>
        {/* Widths of their own: a health that changes after « Retry » moves no column. */}
        <colgroup>
          <col className="w-[20%]" />
          <col className="w-[25%]" />
          <col className={`w-[17%] ${USED_BY_COLUMN}`} />
          <col className="w-[16%]" />
          <col className="w-[11%]" />
          <col className="w-[11%]" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">{t('Connector')}</th>
            <th scope="col">{t('Account')}</th>
            <th scope="col" className={USED_BY_HEAD}>
              <span>{t('Used by')}</span>
            </th>
            <th scope="col">{t('Health')}</th>
            <th scope="col">{t('Last delivery')}</th>
            <th scope="col" data-align="end">
              <span className="sr-only">{t('Actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {connectors.map((connector) => {
            const name = connectorName(connector);
            const waits = late[connector.id];
            const using = sitesOf(connector);
            const failed = waits !== undefined && waits.notes + waits.calls > 0;
            const retries = failed && manages;
            const used = usedBy(connector, using);

            return (
              <tr
                key={connector.id}
                data-connector={connector.id}
                data-chosen={connector.id === selected}
                className={`cursor-pointer ${STACKED.row}`}
                // A press on the row opens its settings, as « … » does: the button is the way of a
                // keyboard and of a screen reader, and a press on a button of the row is its own.
                onClick={(event) => {
                  if ((event.target as Element).closest('button, a') !== null) return;
                  onOpen(connector.id);
                }}
              >
                <td className={STACKED.name}>
                  <span className="flex min-w-0 items-center gap-[10px]">
                    <ConnectorLogo kind={connector.kind} size="row" />
                    {/* The name its workspace gave it, or its kind (FRU-404). */}
                    <span className="min-w-0 truncate font-semibold">{name}</span>
                  </span>
                </td>
                <td className={`max-w-[320px] ${STACKED.account}`}>
                  {/* One line: a long address is cut at its end, and the settings write it whole (FRU-321). */}
                  <span className="block truncate text-ink-soft" title={lineOf(connector)} data-source-line>
                    {lineOf(connector)}
                  </span>
                </td>
                <td
                  className={`whitespace-nowrap text-muted ${USED_BY_CELL} ${STACKED.usedBy} ${used !== undefined && connector.health !== undefined ? STACKED.dot : ''}`}
                  data-used-by
                >
                  {/* A span: the column hides what is in its cells under 900 px. */}
                  {used === undefined ? null : <span>{used}</span>}
                </td>
                <td className={STACKED.health}>
                  <Health
                    connector={connector}
                    late={waits}
                    read={
                      waits !== undefined ||
                      (connector.health === undefined ? !receives(connector) : connector.health.failing === 0)
                    }
                    placeAttention={using?.some((site) =>
                      placesOf(site).some((place) => place.connector === connector.id && place.attention !== undefined),
                    )}
                  />
                </td>
                <td className={`whitespace-nowrap text-muted ${STACKED.last}`} data-last-delivery>
                  <LastDelivery connector={connector} />
                </td>
                <td data-align="end" className={retries ? STACKED.actions : STACKED.alone}>
                  <span className={`inline-flex items-center justify-end gap-[4px] ${TOUCH}`}>
                    {retries ? (
                      <Button
                        tone="outline"
                        size="small"
                        disabled={retrying === connector.id}
                        label={t('Retry {name}', { name })}
                        onClick={() => onRetry(connector, waits.ids)}
                      >
                        <NoteIcon name="retry" />
                        {retrying === connector.id ? t('Retrying…') : t('Retry')}
                      </Button>
                    ) : null}
                    {/* On a card, « … » goes to its top right, beside the name. */}
                    <span className={`inline-flex ${retries ? STACKED.more : ''}`}>
                      <IconButton
                        size="small"
                        label={t('Settings of {name}', { name })}
                        onClick={() => onOpen(connector.id)}
                      >
                        <NoteIcon name="more" />
                      </IconButton>
                    </span>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </DataTable>
    </div>
  );
}
