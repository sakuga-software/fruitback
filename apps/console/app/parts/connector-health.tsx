import type { ReactNode } from 'react';
import type { Connector } from '../api';
import { t } from '../i18n';
import { useLocale } from '../use-locale';
import { trackerOf } from '../trackers/index.ts';
import { isPluginKind } from '../trackers/plugin.ts';

/**
 * The health of a connector (FRU-690): what waits for a connector that receives, and the words of its
 * row. The Connectors screen reads it, its table and its catalogue draw it.
 */

/** What did not reach a connector that receives: notes, and calls of a trigger of a site (FRU-468). */
export type Late = { notes: number; calls: number; ids: readonly string[] };

/**
 * Whether a connector receives each note, and so has a list of the sends that wait: an address, a
 * routine (FRU-594), and a plugin that keeps nothing (FRU-624, Slack). A tracker has none.
 */
export function receives(connector: Connector): boolean {
  if (connector.kind === 'rest' || connector.kind === 'claude-routine') return true;

  return isPluginKind(connector.kind) && trackerOf(connector.kind)?.receives === true;
}

/** The words of a state pill: a dot and a word, in a tint of its colour. */
export function Pill({ tone, children }: { tone: 'done' | 'alert' | 'neutral'; children: ReactNode }) {
  const colours = {
    done: 'bg-done/10 text-done',
    alert: 'bg-accent/10 text-accent-strong',
    neutral: 'bg-chip text-muted',
  }[tone];
  const dot = { done: 'bg-done', alert: 'bg-accent', neutral: 'bg-control' }[tone];

  return (
    <span
      className={`inline-flex h-[20px] flex-none items-center gap-[5px] rounded-control px-[7px] text-hint leading-none font-semibold whitespace-nowrap ${colours}`}
      data-pill={tone}
    >
      <span aria-hidden="true" className={`size-[6px] flex-none rounded-pill ${dot}`} />
      {children}
    </span>
  );
}

/**
 * The health of a connector, in its row (FRU-690), from what the worker says:
 *
 * - « Needs attention »: its tracker refuses it (FRU-102), or refused a place of a site (FRU-640).
 * - « N not delivered »: sends that wait, for a connector that receives (an address, a routine, Slack).
 * - « Healthy »: a connector that receives, whose sends were read, and none waits; or a tracker whose
 *   health the worker said (FRU-714): it takes a note in the request or refuses it, so none waits.
 * - « Connected »: a tracker of a worker that says no health.
 * - « Not read »: the sends of a connector that receives were not read. Never « Healthy ».
 *
 * The red words are the strong accent: the accent is under 4.5:1 on the tints of a row (FRU-683).
 */
export function Health({
  connector,
  late,
  read,
  placeAttention = false,
}: {
  /** With its `health` (FRU-714), when the worker said it. */
  connector: Connector;
  late: Late | undefined;
  /** Whether the sends of a connector that receives were read. A tracker has none to read. */
  read: boolean;
  placeAttention?: boolean | undefined;
}) {
  useLocale();
  if (connector.attention !== undefined || placeAttention) return <Pill tone="alert">{t('Needs attention')}</Pill>;
  if (!read) return <Pill tone="neutral">{t('Not read')}</Pill>;
  if (late === undefined)
    return <Pill tone="done">{connector.health === undefined ? t('Connected') : t('Healthy')}</Pill>;
  const waiting = late.notes + late.calls;
  if (waiting === 0) return <Pill tone="done">{t('Healthy')}</Pill>;

  return (
    <span className="inline-flex flex-wrap gap-[4px]">
      {late.notes > 0 ? (
        <Pill tone="alert">
          {late.notes === 1 ? t('1 note not delivered') : t('{count} notes not delivered', { count: late.notes })}
        </Pill>
      ) : null}
      {/* FRU-468: a call that waits is said too: its agent did not start. */}
      {late.calls > 0 ? (
        <Pill tone="alert">
          {late.calls === 1 ? t('1 call not delivered') : t('{count} calls not delivered', { count: late.calls })}
        </Pill>
      ) : null}
    </span>
  );
}
