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
 */
export function PreviewScene({ launch, hint }: { launch: string; hint: string }) {
  return (
    <div className="scene" aria-hidden="true" inert>
      <div className="scene__nav">
        <span className="scene__name">Acme Outdoor</span>
        <span className="scene__links">
          <span>Shop</span>
          <span>Journal</span>
          <span>Stores</span>
        </span>
      </div>
      <div className="scene__hero">
        <p className="scene__headline">Pack light, walk far.</p>
        <p className="scene__tagline">The spring range is in the shops.</p>
        <span className="scene__action">Shop the range</span>
      </div>
      <div className="scene__products">
        <div>
          <div className="scene__photo" data-tone="blue">
            [product photo]
          </div>
          <p className="scene__product">Ridge 28 pack</p>
        </div>
        <div>
          <div className="scene__photo" data-tone="green">
            [product photo]
          </div>
          <p className="scene__product">Fell shell jacket</p>
        </div>
        <div>
          <div className="scene__photo" data-tone="rose">
            [product photo]
          </div>
          <p className="scene__product">Camp mug, enamel</p>
        </div>
      </div>

      <div className="scene__hint">{hint}</div>
      <div className="scene__dock">
        <span className="scene__settings">
          <svg viewBox="0 0 24 24">
            <path
              fill="currentColor"
              fillRule="evenodd"
              d="M19.62 10.33 L22.10 10.60 L22.10 13.40 L19.62 13.67 L18.57 16.21 L20.13 18.16 L18.16 20.13 L16.21 18.57 L13.67 19.62 L13.40 22.10 L10.60 22.10 L10.33 19.62 L7.79 18.57 L5.84 20.13 L3.87 18.16 L5.43 16.21 L4.38 13.67 L1.90 13.40 L1.90 10.60 L4.38 10.33 L5.43 7.79 L3.87 5.84 L5.84 3.87 L7.79 5.43 L10.33 4.38 L10.60 1.90 L13.40 1.90 L13.67 4.38 L16.21 5.43 L18.16 3.87 L20.13 5.84 L18.57 7.79 Z M15.10 12 A3.1 3.1 0 1 0 8.90 12 A3.1 3.1 0 1 0 15.10 12 Z"
            />
          </svg>
        </span>
        <span className="scene__launch">
          <svg viewBox="16 6 96 116">
            <path d="M 64 121.9 L 30.1 87.9 A 48 48 0 1 1 97.9 87.9 Z" fill="currentColor" />
          </svg>
          {launch}
        </span>
      </div>
    </div>
  );
}
