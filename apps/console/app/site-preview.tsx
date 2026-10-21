import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { type Refusal, refusalOf } from './frame-refusal';
import { DESK, scaleOf } from './preview-scale';
import { PreviewScene } from './preview-scene';
import { msg, t } from './i18n';
import { siteLabel } from './site-address';
import { BrowserFrame, LinkButton } from './ui';
import { useLocale } from './use-locale';

/**
 * The preview of the setup (FRU-354): the site the person added, live, in the window of a browser.
 *
 * The browser of the person loads the site in a frame. The console asks the site for nothing: no
 * server request goes there, so the console cannot read a refusal (`frame-refusal.ts` says what a
 * browser lets it know). The caption says what a blank frame means, and offers the address in place
 * of the frame: the domain, the icon of the site when it gives one, and why. From there « Show an
 * example » shows the example page of before (`preview-scene.tsx`), a picture, as a last resort.
 *
 * The frame is sandboxed: the site runs its scripts and keeps its session, but cannot take the tab
 * away from the console. Its referrer is not sent.
 */

/** The height of the page in the frame of the kit, `.kit-browser__page`. */
const HEIGHT = 620;

const ASKED = 'fruitback:preview-hidden:';

/** Whether the person asked for the address in place of this site, in a visit before. */
function askedBefore(origin: string): boolean {
  try {
    return localStorage.getItem(ASKED + origin) === '1';
  } catch {
    return false;
  }
}

function remember(origin: string, hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(ASKED + origin, '1');
    else localStorage.removeItem(ASKED + origin);
  } catch {
    // A browser that keeps nothing asks again at the next visit.
  }
}

/** The scale of the site in the frame, read again when the frame changes width (`scaleOf`). */
function useScale(): [RefObject<HTMLDivElement | null>, number] {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) return;
    const measure = () => {
      setScale(scaleOf(element.clientWidth));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return [box, scale];
}

export function SitePreview({ origin }: { origin: string }) {
  useLocale();
  const known = refusalOf(origin, window.location.origin);
  const [asked, setAsked] = useState(() => askedBefore(origin));
  const refusal: Refusal | undefined = known ?? (asked ? 'asked' : undefined);
  const label = siteLabel(origin);
  // The domain alone, where a sentence names the site: `staging.acme.dev`, or `localhost:3000`.
  const host = new URL(origin).host;
  const [box, scale] = useScale();
  // The example page of before (FRU-242), on demand, for a site that cannot show: not kept.
  const [example, setExample] = useState(false);

  const ask = (hidden: boolean) => {
    remember(origin, hidden);
    setAsked(hidden);
  };

  // What the frame shows: the site, its address (with why), or the example page.
  let view: 'live' | 'address' | 'example' = 'live';
  if (refusal !== undefined) view = example ? 'example' : 'address';

  let caption: ReactNode;
  let page: ReactNode;
  if (view === 'live') {
    caption = (
      <>
        {t('Your site, as it is now. A blank frame or an error means your site refuses to show inside another page.')}{' '}
        <LinkButton space="flush" onClick={() => ask(true)}>
          {t('Show its address instead')}
        </LinkButton>
      </>
    );
    page = (
      <iframe
        src={`${origin}/`}
        title={t('{site}, live', { site: host })}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        className="site-preview__frame"
        style={
          scale === 1
            ? undefined
            : { width: DESK, height: HEIGHT / scale, transform: `scale(${scale})`, transformOrigin: '0 0' }
        }
      />
    );
  } else if (view === 'example') {
    caption = (
      <>
        {t('An example page. Pins show the same way on your site.')}{' '}
        <LinkButton space="flush" onClick={() => setExample(false)}>
          {t('Show its address instead')}
        </LinkButton>
      </>
    );
    page = <PreviewScene launch={t('Leave feedback')} hint={t('Click Leave feedback, then any part of the page.')} />;
  } else {
    page = (
      <Refused
        origin={origin}
        host={host}
        refusal={refusal ?? 'asked'}
        onShow={() => ask(false)}
        onExample={() => setExample(true)}
      />
    );
  }

  return (
    <BrowserFrame address={label} caption={caption}>
      <div ref={box} className="site-preview">
        {page}
      </div>
    </BrowserFrame>
  );
}

const WHY: Record<Refusal, string> = {
  asked: msg(
    'Many sites refuse to show inside another page: their X-Frame-Options or Content-Security-Policy header says so. Fruitback does not ask your site, so it cannot tell. Pins show on the page itself.',
  ),
  insecure: msg(
    'Your site is on http and this console on https: a browser does not show an http page inside an https one. Pins show on the page itself.',
  ),
  console: msg('This is the address of the console itself: it cannot show inside itself.'),
};

/** The address in place of the frame: the icon of the site, its domain, and why. */
function Refused({
  origin,
  host,
  refusal,
  onShow,
  onExample,
}: {
  origin: string;
  host: string;
  refusal: Refusal;
  onShow: () => void;
  /** Shows the example page in place of the address. */
  onExample: () => void;
}) {
  useLocale();
  // The icon comes from the site, in the browser of the person, as the frame would: https only.
  const [icon, setIcon] = useState(origin.startsWith('https://'));

  return (
    <div className="site-preview__refused">
      {icon ? (
        <img
          src={`${origin}/favicon.ico`}
          alt=""
          width={40}
          height={40}
          referrerPolicy="no-referrer"
          className="site-preview__icon"
          onError={() => setIcon(false)}
        />
      ) : (
        <span aria-hidden="true" className="site-preview__icon site-preview__letter">
          {host
            .replace(/^www\./, '')
            .charAt(0)
            .toUpperCase()}
        </span>
      )}
      <p className="site-preview__host">{host}</p>
      <p className="site-preview__why">{t(WHY[refusal])}</p>
      <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
        <LinkButton space="flush" href={origin} newTab>
          {t('Open {site} in a new tab', { site: host })}
        </LinkButton>
        <LinkButton space="flush" onClick={onExample}>
          {t('Show an example')}
        </LinkButton>
        {refusal === 'asked' ? (
          <LinkButton space="flush" onClick={onShow}>
            {t('Show the live page')}
          </LinkButton>
        ) : null}
      </div>
    </div>
  );
}
