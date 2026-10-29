import { GUIDE_CAPTURED } from './guide-captured';
import { GUIDE_STEPS, controlText, guideParts } from './guide-steps';
import { t, translate } from './i18n';
import { useLocale } from './use-locale';

/**
 * The guide of the extension, folded under the two cards of step 3 of the setup (FRU-486).
 *
 * The steps are `guide-steps.ts`, the source of `docs/reviewing.md` too. The captures are the copy of
 * `docs/assets/guide/` in `public/guide/`: a console shows the captures of its own build, and loads
 * nothing from another site. Only `pnpm guide:captures` writes them.
 */

/** The address of a capture. The version in it makes a browser read the captures of a new release. */
function captureOf(id: string): string {
  return `/guide/${id}.png?v=${GUIDE_CAPTURED.extension}`;
}

export function SetupGuide() {
  const tag = useLocale();
  const words = (sentence: string): string => translate(tag, sentence);

  return (
    <details className="mt-4.5 rounded-[12px] border border-line">
      <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-2 px-4 py-3 text-small font-semibold">
        {t('The extension, step by step')}
        <span className="text-hint font-normal text-muted">
          {t('Captures of the extension {version}', { version: GUIDE_CAPTURED.extension })}
        </span>
      </summary>
      <ol className="flex list-decimal flex-col gap-5 px-4 pb-4 pl-9 text-small">
        {GUIDE_STEPS.map((step) => (
          <li key={step.id} className="pl-1">
            <p className="mb-2">
              {guideParts(words(step.text)).map((part, index) => {
                if ('text' in part) return part.text;
                const control = step.controls[part.control];

                return control === undefined ? null : (
                  <strong key={index} className="font-semibold">
                    {controlText(control, words)}
                  </strong>
                );
              })}
            </p>
            {/* The column of the setup draws a capture at about half its size: a click opens it whole. */}
            <a href={captureOf(step.id)} target="_blank" rel="noopener noreferrer" className="block">
              <img
                src={captureOf(step.id)}
                alt={words(step.alt)}
                loading="lazy"
                className="block h-auto max-w-full rounded-[8px] border border-line"
              />
            </a>
          </li>
        ))}
      </ol>
    </details>
  );
}
