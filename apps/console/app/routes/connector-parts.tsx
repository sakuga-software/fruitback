import { useState } from 'react';
import type { Connector, Site, Stage } from '../api';
import { Confirmation } from '../confirm';
import { locale, msg, t } from '../i18n';
import type { Listed } from '../listed';
import { LinkButton, type Status } from '../ui';
import { useLocale } from '../use-locale';

/**
 * What the Connectors screen and the panels of a source share (FRU-246): how a kind of source is
 * named and drawn, the words of a source, and the gesture that disconnects one.
 */

/** How each kind of source is drawn. The mark is a letter of the mockup, not a logo. */
export const KINDS = {
  linear: { mark: 'L', name: 'Linear' },
  rest: { mark: '{ }', name: 'REST API' },
} as const;

/** What a refused key means for the person, and what to do. */
export const KEY_PROBLEMS: Record<string, string> = {
  'key-refused': msg('Linear refused this key. Copy it again from Linear, in Settings, then Security and access.'),
  'connectors-unavailable': msg('This Fruitback cannot keep a key yet. Its operator must set FRUITBACK_SECRETS_KEY.'),
  'key-lacks-access': msg(
    'Linear knows this key, and it may not list your teams. Create a key with read and write access, then try again.',
  ),
  forbidden: msg('Only an owner or an admin of the workspace connects a source.'),
  unreachable: msg('Fruitback did not answer. Try again.'),
  'store-unavailable': msg('Linear did not answer just now. Your key is not kept: try again in a minute.'),
};

/** The names of the five stages, as the widget shows them on a pin. */
export const STAGE_NAMES: Record<Stage, string> = {
  seeded: msg('New'),
  green: msg('To do'),
  ripening: msg('In progress'),
  ripe: msg('Done'),
  composted: msg('Closed'),
};

/** The status of the kit that draws a stage: the worker keeps the names of before the mockup. */
export const STAGE_STATUS: Record<Stage, Status> = {
  seeded: 'new',
  green: 'todo',
  ripening: 'progress',
  ripe: 'done',
  composted: 'closed',
};

/**
 * The mark of a source: a letter in a white box. « { } » is written in the mono font, as on the mockup,
 * which sizes the box by its content: 34 px inside its border.
 */
export function SourceMark({ children }: { children: string }) {
  return (
    <span
      aria-hidden="true"
      className={`box-content flex h-[34px] w-[34px] flex-none items-center justify-center rounded-field border border-line bg-surface leading-auto font-bold ${
        children.includes('{') ? 'font-mono text-tiny' : 'text-hint'
      }`}
    >
      {children}
    </span>
  );
}

/** The host a receiving connector sends to, as the worker named it: `REST · hooks.acme.dev`. */
export function hostOf(connector: Connector): string {
  return connector.label.replace(/^REST · /, '');
}

/** The host of an address alone, so a button that names it fits the panel (FRU-165). */
export function shortHost(connector: Connector): string {
  const address = hostOf(connector);
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}

/** The person whose key this is, as the worker named the connector: `Linear · Camille`. */
export function personOf(connector: Connector): string {
  return connector.label.replace(/^Linear · /, '');
}

/** A Linear connected with OAuth is named after its workspace of Linear: `Linear OAuth · Acme`. */
export const OAUTH_LABEL = /^Linear OAuth · /;

/** How a source is connected, in one line under its name. */
export function sourceLine(connector: Connector): string {
  if (connector.kind === 'rest') return hostOf(connector);
  if (OAUTH_LABEL.test(connector.label)) {
    return t('Workspace {name}', { name: connector.label.replace(OAUTH_LABEL, '') });
  }

  return t('Key of {person}', { person: personOf(connector) });
}

/** A moment, in the language of the console. */
export function moment(iso: string): string {
  const date = new Date(iso);

  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
}

export function siteCount(count: number): string {
  return count === 1 ? t('{count} site', { count }) : t('{count} sites', { count });
}

/** What the list of sites of a panel says before its rows: loading, not read, or none (FRU-162). */
export function SitesState({ sites }: { sites: Listed<Site> }) {
  useLocale();
  if (sites === 'loading') return <p className="text-small text-muted">{t('Loading…')}</p>;
  if (sites === 'failed') return <p className="text-small text-muted">{t('Fruitback did not answer. Try again.')}</p>;

  return sites.length === 0 ? <p className="text-small text-muted">{t('This workspace has no site yet.')}</p> : null;
}

/** What the panel of a source is given, whatever its kind. */
export type PanelProps = {
  /** The id of the title of the panel. */
  id: string;
  base: string;
  connector: Connector;
  sites: Listed<Site>;
  manages: boolean;
  onChanged: () => Promise<void>;
  onRemoved: () => void;
};

/** The title of a block of a panel. */
export function BlockTitle({ children }: { children: string }) {
  return <h3 className="text-small leading-auto font-semibold">{children}</h3>;
}

/**
 * « Disconnect Linear », at the foot of a panel: underlined words, as the mockup draws them, and a
 * gesture that asks twice (FRU-165). The second time is `Confirmation`. « Keep it » and Escape put
 * the words back, with focus on them.
 */
export function Disconnect({
  label,
  confirmLabel,
  consequence,
  onConfirm,
  keepLabel,
  space = 'normal',
}: {
  label: string;
  confirmLabel: string;
  consequence: string;
  onConfirm: () => void;
  keepLabel?: string;
  /** The space around the words: 10 px at the foot of a panel, 12 px beside a button of a page. */
  space?: 'normal' | 'loose';
}) {
  const [asking, setAsking] = useState(false);
  // Set once the person stepped back: the words then take focus again when they reappear.
  const [back, setBack] = useState(false);

  if (!asking)
    return (
      <LinkButton space={space} autoFocus={back} onClick={() => setAsking(true)}>
        {label}
      </LinkButton>
    );

  return (
    <Confirmation
      confirmLabel={confirmLabel}
      consequence={consequence}
      onConfirm={onConfirm}
      {...(keepLabel === undefined ? {} : { keepLabel })}
      onKeep={() => {
        setBack(true);
        setAsking(false);
      }}
    />
  );
}
