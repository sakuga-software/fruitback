import { CHANNEL, type CaptureResponseMessage, parseBridgeMessage } from './protocol.ts';

/**
 * The two last hops of the answer to a capture (FRU-332), out of `capture.ts`: the page world runs
 * `pictureOfAnswer`, and it reaches no module of the session (`worlds.test.ts`). The first hop is
 * `captureAnswerOf` of `capture.ts`, in the background.
 */

/**
 * The answer of the background, as the bridge posts it to the page world: read by
 * `parseBridgeMessage`, and an answer it refuses is a capture-response with nothing.
 */
export function captureResponseOf(answer: unknown, id: string): CaptureResponseMessage {
  const parsed = parseBridgeMessage({
    ...(typeof answer === 'object' ? answer : {}),
    channel: CHANNEL,
    kind: 'capture-response',
    id,
  });

  return parsed?.kind === 'capture-response' ? parsed : { channel: CHANNEL, kind: 'capture-response', id };
}

/**
 * The file the page world hands the composer for an answer. A capture said too large is a file of its
 * size with no bytes: the composer refuses it as too large (`refusalBefore` reads its size), and it
 * is never sent.
 */
export function pictureOfAnswer(answer: CaptureResponseMessage): CaptureResponseMessage['picture'] {
  if (answer.picture !== undefined) return answer.picture;
  const large = answer.tooLarge;
  if (large === undefined) return undefined;

  return {
    name: large.name,
    type: large.name.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
    size: large.size,
    base64: '',
  };
}

/**
 * What the page world gives the widget for an answer (FRU-423): the file of `pictureOfAnswer`, or a
 * rejection named `NotAllowedError` when the browser refused the capture for want of a gesture. The
 * widget says to click the icon; a widget of before reads the rejection as « not taken ».
 */
export function captureOfAnswer(answer: CaptureResponseMessage): CaptureResponseMessage['picture'] {
  const picture = pictureOfAnswer(answer);
  if (picture === undefined && answer.refused === 'permission') {
    throw Object.assign(new Error('The browser refused the capture: click the Fruitback icon.'), {
      name: 'NotAllowedError',
    });
  }

  return picture;
}
