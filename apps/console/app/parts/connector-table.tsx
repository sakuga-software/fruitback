import { type Connector, type Site, placesOf } from '../api';
import { t } from '../i18n';
import { Button, DataTable, IconButton } from '../ui';
import { useLocale } from '../use-locale';
import { ConnectorLogo } from '../connector-logos';
import { NoteIcon } from '../note-icons';
import { KINDS, connectorName, siteCount, sourceLine } from './connector-parts';
import { Health, type Late, receives } from './connector-health';

/** The account of a source, in its row: its kind first when a name hides it (FRU-404). */
function lineOf(connector: Connector): string {
  return connector.name === undefined
    ? sourceLine(connector)
    : `${t(KINDS[connector.kind].name)} · ${sourceLine(connector)}`;
}

/**
 * The table « Your connectors » (FRU-690): a row for each connector, with its logo and its name, its
 * account, the sites that use it, its health, « Retry » when its sends wait, and « … » that opens its
 * settings. A card for each row under 680 px (`DataTable` with `stack`).
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
    <DataTable label={t('Your connectors')} minWidth={680} dense hover stack>
      {/* Widths of their own: a health that changes after « Retry » moves no column. */}
      <colgroup>
        <col className="w-[24%]" />
        <col className="w-[32%]" />
        <col className="w-[12%]" />
        <col className="w-[20%]" />
        <col className="w-[12%]" />
      </colgroup>
      <thead>
        <tr>
          <th scope="col">{t('Connector')}</th>
          <th scope="col">{t('Account')}</th>
          <th scope="col">{t('Used by')}</th>
          <th scope="col">{t('Health')}</th>
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

          return (
            <tr
              key={connector.id}
              data-connector={connector.id}
              data-chosen={connector.id === selected}
              className="cursor-pointer"
              // A press on the row opens its settings, as « … » does: the button is the way of a
              // keyboard and of a screen reader, and a press on a button of the row is its own.
              onClick={(event) => {
                if ((event.target as Element).closest('button, a') !== null) return;
                onOpen(connector.id);
              }}
            >
              <td>
                <span className="flex min-w-0 items-center gap-[10px]">
                  <ConnectorLogo kind={connector.kind} size="row" />
                  {/* The name its workspace gave it, or its kind (FRU-404). */}
                  <span className="min-w-0 truncate font-semibold">{name}</span>
                </span>
              </td>
              <td className="max-w-[320px]">
                {/* One line: a long address is cut at its end, and the settings write it whole (FRU-321). */}
                <span className="block truncate text-ink-soft" title={lineOf(connector)} data-source-line>
                  {lineOf(connector)}
                </span>
              </td>
              <td className="whitespace-nowrap text-muted">
                {/* FRU-594: no site sends its notes to a routine, so its row counts none. */}
                {using === undefined || connector.kind === 'claude-routine' ? null : siteCount(using.length)}
              </td>
              <td>
                <Health
                  connector={connector}
                  late={waits}
                  read={!receives(connector) || waits !== undefined}
                  placeAttention={using?.some((site) =>
                    placesOf(site).some((place) => place.connector === connector.id && place.attention !== undefined),
                  )}
                />
              </td>
              <td data-align="end">
                <span className="inline-flex items-center justify-end gap-[4px]">
                  {failed && manages ? (
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
                  <IconButton
                    size="small"
                    label={t('Settings of {name}', { name })}
                    onClick={() => onOpen(connector.id)}
                  >
                    <NoteIcon name="more" />
                  </IconButton>
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </DataTable>
  );
}
