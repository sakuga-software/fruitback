/// <reference types="vite/client" />
import type { Decorator, Preview } from '@storybook/html-vite';
import popupSheet from '../../entrypoints/popup/style.css?inline';
import panelSheet from '../../entrypoints/sidepanel/style.css?inline';
import welcomeSheet from '../../entrypoints/welcome/style.css?inline';
import kitSheet from '../../src/kit.css?inline';
import { setLanguage } from '../../src/i18n.ts';
import gallerySheet from '../gallery.css?inline';
import { unmountWidget } from '../widget-page.ts';

type Sheets = { sheets: string[]; bodyClass?: string };

const WIDGET: Sheets = { sheets: [] };
const SURFACES: Record<string, Sheets> = {
  popup: { sheets: [popupSheet, kitSheet], bodyClass: 'popup-page' },
  welcome: { sheets: [popupSheet, kitSheet, welcomeSheet] },
  panel: { sheets: [popupSheet, kitSheet, panelSheet], bodyClass: 'side-panel-page' },
  widget: WIDGET,
};
const BODY_CLASSES = ['popup-page', 'side-panel-page'];

/**
 * One document draws every story. The decorator gives each story the sheets and the class of `body`
 * of its own page in the extension, and takes away the ones of the story before.
 */
const surfaceOf: Decorator = (story, context) => {
  unmountWidget();
  const surface = SURFACES[String(context.parameters.surface)] ?? WIDGET;
  document.querySelectorAll('style[data-gallery-sheet]').forEach((sheet) => sheet.remove());
  for (const text of [...surface.sheets, gallerySheet]) {
    const sheet = document.createElement('style');
    sheet.dataset.gallerySheet = '';
    sheet.textContent = text;
    document.head.append(sheet);
  }
  document.body.classList.remove(...BODY_CLASSES);
  if (surface.bodyClass !== undefined) document.body.classList.add(surface.bodyClass);
  document.body.classList.add('gallery-all');
  const language = String(context.globals.locale ?? 'en');
  document.documentElement.lang = language;
  setLanguage(language);

  return story();
};

const preview: Preview = {
  decorators: [surfaceOf],
  parameters: { layout: 'padded' },
  globalTypes: {
    locale: {
      description: 'The language of the screens',
      toolbar: {
        title: 'Language',
        icon: 'globe',
        items: [
          { value: 'en', title: 'English' },
          { value: 'fr', title: 'Français' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { locale: 'en' },
};

export default preview;
