/**
 * What the tabs of the console of one browser tell each other when a sign-in link is opened
 * (FRU-235).
 *
 * Somebody asks for a link in one tab, and their mail opens it in another. The tab of the link tells
 * the others that the browser is signed in now, and the tab that waited goes on by itself.
 *
 * WARNING: a message here is a hint, and never a proof. It carries no token, no account and no
 * address: a tab that hears « signed-in » asks the worker who is signed in (`GET /console/me`), and
 * goes on only on its answer. A `BroadcastChannel` reaches the pages of this origin only.
 */
const NAME = 'fruitback:sign-in';

/** « signed-in »: from the tab of the link. « heard », then « carried-on »: from a tab that waited. */
const WORDS = ['signed-in', 'heard', 'carried-on'] as const;
type Word = (typeof WORDS)[number];

/** The part of a `BroadcastChannel` that is used here, so a test gives its own. */
export type Channel = {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: unknown }) => void) | null;
};

function open(): Channel | undefined {
  if (typeof BroadcastChannel === 'undefined') return undefined;
  const real = new BroadcastChannel(NAME);
  const channel: Channel = {
    onmessage: null,
    postMessage: (message) => real.postMessage(message),
    close: () => real.close(),
  };
  real.onmessage = (event) => channel.onmessage?.({ data: event.data as unknown });

  return channel;
}

function word(data: unknown): Word | undefined {
  return WORDS.find((each) => each === data);
}

/**
 * How long the tab of the link waits. A tab that waits says « heard » at once, so a link opened
 * alone costs 400 ms. A tab that heard then asks the worker, which can take the time of a call.
 */
export const WAITS: { heard: number; carried: number } = { heard: 400, carried: 5_000 };

/**
 * From the tab of the link, once its token is spent: tells the other tabs, and answers `true` when
 * one of them said that it carried on. `false`: no tab waited, or none could go on, and this tab is
 * the console.
 */
export function announceSignIn(make: () => Channel | undefined = open, waits = WAITS): Promise<boolean> {
  const channel = make();
  if (channel === undefined) return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const end = (carried: boolean) => {
      clearTimeout(timer);
      channel.onmessage = null;
      channel.close();
      resolve(carried);
    };
    timer = setTimeout(() => end(false), waits.heard);
    channel.onmessage = (event) => {
      const said = word(event.data);
      if (said === 'carried-on') return end(true);
      if (said !== 'heard') return;
      // A tab is there and asks the worker: wait for it, the time of its call.
      clearTimeout(timer);
      timer = setTimeout(() => end(false), waits.carried);
    };
    channel.postMessage('signed-in' satisfies Word);
  });
}

/**
 * In a tab that waits for a link to be opened. When another tab says that the browser is signed in,
 * `signedIn` asks the worker; on `true` this tab says that it carried on, then `carryOn` runs.
 * Returns how to stop listening.
 */
export function awaitSignIn(
  signedIn: () => Promise<boolean>,
  carryOn: () => void,
  make: () => Channel | undefined = open,
): () => void {
  const channel = make();
  if (channel === undefined) return () => {};
  let stopped = false;
  channel.onmessage = (event) => {
    if (word(event.data) !== 'signed-in') return;
    channel.postMessage('heard' satisfies Word);
    void signedIn().then((yes) => {
      if (stopped || !yes) return;
      channel.postMessage('carried-on' satisfies Word);
      carryOn();
    });
  };

  return () => {
    stopped = true;
    channel.onmessage = null;
    channel.close();
  };
}
