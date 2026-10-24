import { GITHUB_MARK } from './provider-icons';

/**
 * The mark of a kind of source beside its name (FRU-435), drawn inline: no CDN, no request.
 *
 * - Linear: the logo of Linear, from simple-icons 15.0.0 (`icons/linear.svg`, CC0-1.0).
 * - GitHub Issues: the mark of GitHub, the one of the sign-in button (`provider-icons.tsx`).
 * - REST API: two braces, the « { } » that the mockup writes for an address, drawn as lines. A text
 *   would join the words of its cell.
 *
 * The name beside it says the kind, so a mark is `aria-hidden` and takes no focus. It takes the colour
 * of the name.
 */
export type MarkedKind = 'linear' | 'github' | 'rest';

const LINEAR_MARK =
  'M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z';

const BRACES =
  'M6 2.5c-1.5 0-2 .7-2 2v1.8c0 .9-.5 1.5-1.5 1.7 1 .2 1.5.8 1.5 1.7v1.8c0 1.3.5 2 2 2M10 2.5c1.5 0 2 .7 2 2v1.8c0 .9.5 1.5 1.5 1.7-1 .2-1.5.8-1.5 1.7v1.8c0 1.3-.5 2-2 2';

export function ConnectorMark({ kind }: { kind: MarkedKind }) {
  if (kind === 'rest') {
    return (
      <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" className="size-[14px] flex-none">
        <path d={BRACES} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={kind === 'linear' ? '0 0 24 24' : '0 0 16 16'}
      className="size-[14px] flex-none fill-current"
    >
      <path d={kind === 'linear' ? LINEAR_MARK : GITHUB_MARK} />
    </svg>
  );
}
