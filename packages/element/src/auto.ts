import { defineFruitbackElement } from './index.ts';

/**
 * `import '@fruitback/element/auto'` registers `<fruitback-widget>`, and so does the script
 * `dist/fruitback-element.iife.js` on a page with no build step.
 *
 * The side effect lives in this file only, so the main entry can be imported on a server.
 */
defineFruitbackElement();
