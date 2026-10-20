import { browser } from 'wxt/browser';
import { language, setLanguage } from '../../src/i18n.ts';
import { storedLanguage } from '../../src/language.ts';
import { welcomeScreen } from '../../src/welcome.ts';

/** The page that opens at install (FRU-318): what `src/welcome.ts` draws, in the reviewer's language. */
setLanguage((await storedLanguage(browser.storage.local)) ?? navigator.language);
document.documentElement.lang = language();

document.querySelector('#app')?.replaceChildren(
  welcomeScreen(document, {
    // `action.openPopup` needs no permission. Where the browser does not let a page call it, it
    // rejects, and the page says where the icon is.
    openPopup: () => browser.action.openPopup(),
  }),
);
