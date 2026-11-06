import type { NoteStage } from '@fruitback/shared';

/**
 * The round of a stage, which fills as a note moves on, like the status icons of Linear (FRU-606):
 * « New » a dashed ring, « To do » an empty ring, « In progress » a ring half full, « Done » a full
 * round with a tick, « Closed » a full round with a cross. It says the stage by its shape as well as
 * by its colour, so the list never says a stage by a colour alone.
 *
 * Drawn in `currentColor`: the caller sets the colour of its stage or of its status. The tick and
 * the cross take `--fruitback-stage-ring-mark`, the surface by default. Decorative: the word of the
 * stage is always beside it. The widget's list and the side panel of the extension draw the same one.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/** How full the round of each stage is, and the mark on a full one. */
const RINGS: Record<NoteStage, { dashed?: true; fill: 0 | 0.5 | 1; mark?: string }> = {
  new: { dashed: true, fill: 0 },
  todo: { fill: 0 },
  progress: { fill: 0.5 },
  done: { fill: 1, mark: 'M5 8.2 L7.1 10.2 L11 6' },
  closed: { fill: 1, mark: 'M5.6 5.6 L10.4 10.4 M10.4 5.6 L5.6 10.4' },
};

function element(document: Document, name: string, attributes: Record<string, string>): SVGElement {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);

  return node;
}

export function createStageRing(
  document: Document,
  stage: NoteStage,
  className = 'fruitback-stage-ring',
): SVGSVGElement {
  const ring = RINGS[stage];
  const svg = element(document, 'svg', {
    viewBox: '0 0 16 16',
    class: className,
    'aria-hidden': 'true',
    focusable: 'false',
  }) as SVGSVGElement;
  svg.dataset.stage = stage;
  if (ring.fill === 1) {
    svg.append(element(document, 'circle', { cx: '8', cy: '8', r: '7', fill: 'currentColor' }));
  } else {
    svg.append(
      element(document, 'circle', {
        cx: '8',
        cy: '8',
        r: '6.2',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '1.6',
        ...(ring.dashed === true ? { 'stroke-dasharray': '2.4 1.9' } : {}),
      }),
    );
  }
  // The half of a stage in progress: the right half of the inside, as Linear fills it.
  if (ring.fill === 0.5) svg.append(element(document, 'path', { d: 'M8 4 A4 4 0 0 1 8 12 Z', fill: 'currentColor' }));
  if (ring.mark !== undefined) {
    svg.append(
      element(document, 'path', {
        d: ring.mark,
        fill: 'none',
        stroke: 'var(--fruitback-stage-ring-mark, #fff)',
        'stroke-width': '1.6',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
      }),
    );
  }

  return svg;
}
