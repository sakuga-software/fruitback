import './preview-scene.css';

/**
 * The example page of the setup (FRU-242): the scene of screen 01 of the mockup of 2026-10-13, in
 * the window of the preview.
 *
 * It is a picture, not the site of the person: nothing here asks their site for anything, and no
 * frame loads it (decided on 2026-10-13: a fixed illustration). So it is hidden from a screen
 * reader and `inert`: its two buttons are drawn, and take no focus and no press. The caption under
 * the window says what the picture is.
 *
 * The words of the shop are the picture's, in English as on the mockup. The two sentences that are
 * Fruitback's come from the screen, in the language of the person.
 *
 * The `scene__*` names carry no style (FRU-678): the specs find the parts of the picture by them.
 */
type FirstNote = {
  /** « New », in the language of the person. */
  status: string;
  /** The words of the example note: a picture's, as the shop's. */
  text: string;
  /** « {name} · just now », in the language of the person. */
  by: string;
};

/** A photo of a product: a tint of the shop, and its words at its foot. */
const PHOTO =
  'scene__photo flex items-end box-border h-[120px] p-[8px] rounded-[4px] font-sans text-[11px] leading-auto';
const TONES = {
  blue: 'bg-(--scene-blue) text-(--scene-blue-ink)',
  green: 'bg-(--scene-green) text-(--scene-green-ink)',
  rose: 'bg-(--scene-rose) text-(--scene-rose-ink)',
} as const;

/**
 * `note`: the first note came (FRU-242). The picture then has its pin on the headline and its card,
 * as the mockup draws the state `first-note`, and no more hint.
 */
export function PreviewScene({ launch, hint, note }: { launch: string; hint: string; note?: FirstNote }) {
  return (
    <div
      className="scene relative h-full bg-(--scene-paper) text-(--scene-ink) [font-family:var(--scene-serif)] select-none"
      aria-hidden="true"
      inert
    >
      <div className="scene__nav flex items-center justify-between gap-[16px] py-[18px] px-[28px] leading-auto">
        <span className="scene__name text-[17px] font-bold tracking-[0.02em]">Acme Outdoor</span>
        {/* A word of the menu of the picture stays whole on a phone: the rule of the text breaks it anywhere. */}
        <span className="scene__links flex gap-[20px] [overflow-wrap:normal] whitespace-nowrap font-sans text-[13px]">
          <span>Shop</span>
          <span>Journal</span>
          <span>Stores</span>
        </span>
      </div>
      <div className="scene__hero relative my-0 mx-[28px] pt-[44px] px-[36px] pb-[40px] rounded-[6px] bg-(--scene-forest) text-(--scene-paper)">
        <p className="scene__headline relative max-w-[340px] text-[40px] leading-[1.06]">
          Pack light, walk far.
          {note === undefined ? null : (
            <span className="scene__frame absolute -inset-[4px] border-2 border-accent rounded-[6px]">
              <span className="scene__pin absolute right-full bottom-full grid place-items-center size-[26px] rounded-[50%_50%_50%_0] bg-accent [box-shadow:var(--shadow-pin)] [transform:rotate(-90deg)]">
                <span className="text-accent-foreground font-sans text-(length:--text-hint) font-semibold leading-none [transform:rotate(90deg)]">
                  1
                </span>
              </span>
            </span>
          )}
        </p>
        <p className="scene__tagline mt-[14px] mx-0 mb-[22px] text-(--scene-tagline) font-sans text-[14px] leading-auto">
          The spring range is in the shops.
        </p>
        <span className="scene__action inline-block py-[10px] px-[16px] rounded-[4px] bg-(--scene-paper) text-(--scene-ink) font-sans text-[13px] font-semibold leading-auto">
          Shop the range
        </span>
        {note === undefined ? null : (
          <div className="scene__note absolute top-[150px] left-[36px] flex flex-col gap-[6px] box-border w-[264px] py-[14px] px-[16px] rounded-frame bg-surface text-ink [box-shadow:0_10px_30px_var(--scene-shadow)] font-sans">
            <span className="scene__note-status flex items-center gap-[6px] text-(length:--text-hint) font-semibold leading-auto tracking-button">
              <span className="scene__note-drop size-[9px] rounded-[50%_50%_50%_0] bg-status-new [transform:rotate(-90deg)]" />
              {note.status}
            </span>
            <span className="scene__note-text text-(length:--text-small) leading-[1.5]">{note.text}</span>
            <span className="scene__note-by text-muted text-[12px] leading-[1.5]">{note.by}</span>
          </div>
        )}
      </div>
      <div className="scene__products grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-[16px] py-[24px] px-[28px]">
        <div>
          <div className={`${PHOTO} ${TONES.blue}`} data-tone="blue">
            [product photo]
          </div>
          <p className="scene__product mt-[8px] text-[14px] leading-auto">Ridge 28 pack</p>
        </div>
        <div>
          <div className={`${PHOTO} ${TONES.green}`} data-tone="green">
            [product photo]
          </div>
          <p className="scene__product mt-[8px] text-[14px] leading-auto">Fell shell jacket</p>
        </div>
        <div>
          <div className={`${PHOTO} ${TONES.rose}`} data-tone="rose">
            [product photo]
          </div>
          <p className="scene__product mt-[8px] text-[14px] leading-auto">Camp mug, enamel</p>
        </div>
      </div>

      {note === undefined ? (
        <div className="scene__hint absolute right-[18px] bottom-[74px] max-w-[230px] py-[10px] px-[14px] rounded-box bg-ink text-surface [box-shadow:0_10px_30px_var(--scene-shadow)] font-sans text-(length:--text-hint) leading-[1.45] after:absolute after:right-[52px] after:-bottom-[5px] after:size-[10px] after:bg-ink after:[transform:rotate(45deg)] after:content-['']">
          {hint}
        </div>
      ) : null}
      <div className="scene__dock absolute right-[18px] bottom-[18px] flex items-center gap-[8px] font-sans">
        <span className="scene__settings flex items-center justify-center size-[36px] rounded-[999px] bg-avatar text-surface [box-shadow:0_4px_18px_var(--scene-shadow-dock)]">
          <svg viewBox="0 0 24 24" className="size-[16px]">
            <path
              fill="currentColor"
              fillRule="evenodd"
              d="M19.62 10.33 L22.10 10.60 L22.10 13.40 L19.62 13.67 L18.57 16.21 L20.13 18.16 L18.16 20.13 L16.21 18.57 L13.67 19.62 L13.40 22.10 L10.60 22.10 L10.33 19.62 L7.79 18.57 L5.84 20.13 L3.87 18.16 L5.43 16.21 L4.38 13.67 L1.90 13.40 L1.90 10.60 L4.38 10.33 L5.43 7.79 L3.87 5.84 L5.84 3.87 L7.79 5.43 L10.33 4.38 L10.60 1.90 L13.40 1.90 L13.67 4.38 L16.21 5.43 L18.16 3.87 L20.13 5.84 L18.57 7.79 Z M15.10 12 A3.1 3.1 0 1 0 8.90 12 A3.1 3.1 0 1 0 15.10 12 Z"
            />
          </svg>
        </span>
        <span className="scene__launch flex items-center gap-[8px] h-[40px] py-0 px-[16px] rounded-[999px] bg-accent text-accent-foreground [box-shadow:0_4px_18px_var(--scene-shadow-dock)] text-(length:--text-hint) font-semibold leading-auto tracking-button">
          <svg viewBox="16 6 96 116" className="w-[12px] h-[14px]">
            <path d="M 64 121.9 L 30.1 87.9 A 48 48 0 1 1 97.9 87.9 Z" fill="currentColor" />
          </svg>
          {launch}
        </span>
      </div>
    </div>
  );
}
