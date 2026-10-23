import { useState } from 'react';

/**
 * The icon of a site: its `/favicon.ico`, asked by the browser of the person, and the first letter of
 * its host when there is none (FRU-354, FRU-408).
 *
 * The console asks no other service for it: the request goes to the site itself, with no referrer.
 * The policy of the image allows `img-src https:` only, so a site on `http` (a host of this machine)
 * gets its letter, as an icon that does not load does.
 */
export function SiteIcon({
  origin,
  className,
  letterClassName,
}: {
  origin: string;
  /** The box of the icon, and of the letter. */
  className: string;
  /** What the letter adds to the box: its border, its colours and its type. */
  letterClassName: string;
}) {
  const [icon, setIcon] = useState(origin.startsWith('https://'));
  const host = hostOf(origin);

  return icon ? (
    <img
      src={`${origin}/favicon.ico`}
      alt=""
      referrerPolicy="no-referrer"
      decoding="async"
      className={className}
      onError={() => setIcon(false)}
    />
  ) : (
    <span aria-hidden="true" className={`${className} ${letterClassName}`}>
      {host
        .replace(/^www\./, '')
        .charAt(0)
        .toUpperCase()}
    </span>
  );
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
