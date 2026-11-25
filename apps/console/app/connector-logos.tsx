import { ConnectorMark, type LaterKind, type MarkedKind } from './connector-marks';
import { hasLogo, logoPath } from './connector-logo-kinds.ts';

/** The box of a logo: 36 px with a logo of 20 px on a tile, 24 px with 14 px in a row of the table. */
const BOX = {
  tile: 'size-[36px] [&>*]:size-[20px]',
  row: 'size-[24px] [&>*]:size-[14px]',
} as const;

/**
 * The logo of a kind of source on the Connectors screen (FRU-690): an SVG file that the console
 * serves itself, `public/logos/<kind>.svg`, in the colours of its brand, as the mockup draws them.
 * No third party is asked, and the policy of the image does not change: `img-src 'self'` takes it.
 *
 * - Linear, Jira, GitHub, GitLab, Asana, ClickUp, Trello, Notion, Slack: simple-icons 15.0.0
 *   (CC0-1.0), each in the colour simple-icons gives it. The marks stay trademarks of their owners:
 *   they name the service that a connector reaches.
 * - Webhook and a Claude Code routine: the icons `webhook` and `terminal` of Lucide (ISC).
 * - REST API: the two braces of FRU-435, drawn for Fruitback.
 *
 * Each file says its source and its licence in a comment. The name beside the logo says the kind, so
 * the picture has an empty `alt` and its box is `aria-hidden`. Elsewhere (a row of Notes, a place of
 * a site) a source keeps its mark in the colour of the text: `connector-marks.tsx`.
 *
 * A kind with no file (a plugin of a later worker) takes its mark of `connector-marks.tsx`.
 */
export function ConnectorLogo({ kind, size = 'tile' }: { kind: MarkedKind | LaterKind; size?: 'tile' | 'row' }) {
  return (
    <span
      aria-hidden="true"
      className={`box-border flex flex-none items-center justify-center rounded-control border border-line bg-surface text-ink ${BOX[size]}`}
    >
      {hasLogo(kind) ? (
        <img src={logoPath(kind)} alt="" draggable={false} decoding="async" data-logo={kind} />
      ) : (
        <ConnectorMark kind={kind} />
      )}
    </span>
  );
}
