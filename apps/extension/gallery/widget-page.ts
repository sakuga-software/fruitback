import type { NoteIssue } from '@fruitback/shared';
import { noteFixture, noteIssueFixture } from '@fruitback/shared/note.fixture';
import { type Fruitback, init } from '@fruitback/widget';
import type { TransportRequest, TransportResponse } from '@fruitback/widget';

/**
 * The widget of Fruitback on a made-up page, for the gallery. A transport in this file answers in
 * place of the worker, so the gallery needs no worker and keeps nothing.
 */

const ENDPOINT = 'https://worker.gallery.invalid';

const PAGE = `
  <header class="demo-head">
    <strong class="demo-logo">Acme</strong>
    <nav class="demo-nav"><a href="#pricing">Pricing</a><a href="#docs">Docs</a><a href="#blog">Blog</a></nav>
  </header>
  <main class="demo-main">
    <section class="demo-hero">
      <h1 data-demo="title">Ship the site your clients asked for</h1>
      <p data-demo="lead">Every plan comes with a staging site, a review link and the notes of your client.</p>
      <button type="button" class="demo-cta" data-demo="cta">Start a free trial</button>
    </section>
    <section class="demo-plans">
      <article class="demo-plan" data-demo="plan-team"><h2>Team</h2><p class="demo-price">€29 / month</p><p>Five seats, one site.</p></article>
      <article class="demo-plan" data-demo="plan-agency"><h2>Agency</h2><p class="demo-price">€99 / month</p><p>Twenty seats, ten sites.</p></article>
      <article class="demo-plan" data-demo="plan-studio"><h2>Studio</h2><p class="demo-price">On request</p><p>Your seats, your sites.</p></article>
    </section>
  </main>
`;

const STYLE = `
  .demo-page { min-height: 100vh; margin: 0; background: #fafaf9; color: #1c1917; font: 16px/1.5 system-ui, sans-serif; }
  .demo-head { display: flex; align-items: center; justify-content: space-between; padding: 20px 48px; border-bottom: 1px solid #e7e5e4; }
  .demo-logo { font-size: 20px; }
  .demo-nav { display: flex; gap: 24px; }
  .demo-nav a { color: inherit; text-decoration: none; }
  .demo-main { max-width: 960px; margin: 0 auto; padding: 64px 48px; }
  .demo-hero h1 { max-width: 640px; margin: 0 0 16px; font-size: 44px; line-height: 1.1; }
  .demo-hero p { max-width: 520px; margin: 0 0 28px; color: #57534e; }
  .demo-cta { padding: 12px 20px; border: 0; border-radius: 8px; background: #b91c1c; color: #fff; font: inherit; font-weight: 600; }
  .demo-plans { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 72px; }
  .demo-plan { padding: 24px; border: 1px solid #e7e5e4; border-radius: 12px; background: #fff; }
  .demo-plan h2 { margin: 0 0 8px; font-size: 20px; }
  .demo-price { font-size: 24px; font-weight: 700; }
`;

function anchorOn(name: string, tag: string, text: string) {
  return {
    selector: `[data-demo="${name}"]`,
    domPath: `[data-demo="${name}"]`,
    tag,
    text,
    attrs: {},
    bounds: { xPct: 10, yPct: 10, wPct: 20, hPct: 5 },
  };
}

const PAGE_OF_NOTE = { url: 'https://gallery.fruitback.com/', path: '/', title: 'Acme' };

function issueOn(
  name: string,
  tag: string,
  text: string,
  issue: Partial<NoteIssue> & { id: string; identifier: string },
  note: { text: string; reporter?: string; createdAt: string },
): NoteIssue {
  return noteIssueFixture({
    url: `https://linear.app/acme/issue/${issue.identifier}`,
    title: note.text,
    ...issue,
    note: noteFixture({
      id: `note-${issue.id}`,
      text: note.text,
      createdAt: note.createdAt,
      page: PAGE_OF_NOTE,
      anchor: anchorOn(name, tag, text),
      ...(note.reporter === undefined ? {} : { reporter: { name: note.reporter } }),
    }),
  });
}

/** The note that the stories of the pin window open: it has a reply from the team. */
export const OPENED = 'note-cta';

export const NOTES: NoteIssue[] = [
  issueOn(
    'cta',
    'button',
    'Start a free trial',
    {
      id: 'cta',
      identifier: 'WEB-12',
      stage: 'progress',
      stateName: 'In Progress',
      mine: true,
      updatedAt: '2026-10-30T15:00:00.000Z',
      comments: [
        {
          id: 'c1',
          body: 'Good catch, the red is the old one. We move to the brand red this week.',
          createdAt: '2026-10-30T14:20:00.000Z',
          author: 'Marc Petit',
        },
      ],
    },
    {
      text: 'The button reads as an error. Can it take the colour of the brand?',
      reporter: 'Ana Duval',
      createdAt: '2026-10-29T09:12:00.000Z',
    },
  ),
  issueOn(
    'title',
    'h1',
    'Ship the site your clients asked for',
    { id: 'title', identifier: 'WEB-9', stage: 'new', stateName: 'Triage', updatedAt: '2026-10-31T08:00:00.000Z' },
    {
      text: 'Say « review » in the title: it is what the page sells.',
      reporter: 'Léa Martin',
      createdAt: '2026-10-31T08:00:00.000Z',
    },
  ),
  issueOn(
    'plan-agency',
    'article',
    'Agency',
    { id: 'agency', identifier: 'WEB-7', stage: 'todo', stateName: 'Todo', updatedAt: '2026-10-28T11:00:00.000Z' },
    { text: 'The price of the agency plan is €89 now.', reporter: 'Léa Martin', createdAt: '2026-10-27T16:40:00.000Z' },
  ),
  issueOn(
    'plan-studio',
    'article',
    'Studio',
    {
      id: 'studio',
      identifier: 'WEB-4',
      stage: 'done',
      stateName: 'Done',
      mine: true,
      updatedAt: '2026-10-26T10:00:00.000Z',
    },
    { text: 'Add a line on the support of this plan.', reporter: 'Ana Duval', createdAt: '2026-10-24T10:05:00.000Z' },
  ),
];

/** A transport that answers as the worker of a workspace would, and keeps nothing. */
export function galleryTransport(read: { canReply?: boolean; canWrite?: boolean; issues?: NoteIssue[] } = {}) {
  return async (request: TransportRequest): Promise<TransportResponse> => {
    if (request.method === 'GET') {
      const body = {
        issues: read.issues ?? NOTES,
        identified: true,
        canReply: read.canReply ?? true,
        canWrite: read.canWrite ?? true,
      };

      return { ok: true, status: 200, body: JSON.stringify(body) };
    }
    if (request.url.includes('/replies')) {
      return {
        ok: true,
        status: 201,
        body: JSON.stringify({ comment: { id: 'reply', body: 'kept', createdAt: new Date().toISOString() } }),
      };
    }

    return { ok: false, status: 503, body: JSON.stringify({ error: 'The gallery keeps no note.' }) };
  };
}

let mounted: Fruitback | undefined;

/** Destroys the widget of the last story. The decorator calls it before every story. */
export function unmountWidget(): void {
  mounted?.destroy();
  mounted = undefined;
}

export type WidgetStage = { widget: Fruitback; page: HTMLElement };

/**
 * Draws the made-up page, then mounts the widget on it, after the page is in the document. The
 * widget finds its elements by their selectors, so the page must be in the document first.
 */
export function widgetPage(
  locale: string,
  read: Parameters<typeof galleryTransport>[0] = {},
): { page: HTMLElement; mount: () => Promise<WidgetStage> } {
  const page = document.createElement('div');
  page.className = 'demo-page';
  const style = document.createElement('style');
  style.textContent = STYLE;
  page.innerHTML = PAGE;
  page.prepend(style);

  return {
    page,
    mount: async () => {
      unmountWidget();
      mounted = init({
        endpoint: ENDPOINT,
        clientId: 'acme',
        locale,
        transport: galleryTransport(read),
        reporterName: 'Ana Duval',
      });
      await mounted.refresh();

      return { widget: mounted, page };
    },
  };
}

/** The center of an element of the page, as a pointer would reach it. */
export function pointAt(element: Element): { clientX: number; clientY: number } {
  const box = element.getBoundingClientRect();

  return { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
}
