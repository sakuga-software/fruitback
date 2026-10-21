import { expect, test } from '@playwright/test';
import { LONG_URL, overflows } from './overflow.ts';

/**
 * The control of `overflows` (FRU-350): an absence proves nothing until the check is seen to fail.
 * Each fault is planted on a bare page, and each case meant to scroll is planted beside it.
 */
test('overflows names each planted fault, and lets a rail of tabs and a table scroll', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 600 });
  await page.setContent(`
    <body style="margin:0;font:16px sans-serif">
      <p id="cut" style="width:100px;overflow-wrap:normal">${LONG_URL}</p>
      <div style="position:absolute;left:280px;top:200px;width:120px;white-space:nowrap">Past the screen</div>
      <div style="display:flex;width:300px"><span style="flex:1 1 0;min-width:0;overflow-wrap:anywhere">Squeezed into a column of letters</span><span style="flex:none;width:290px">x</span></div>
      <div style="width:200px;overflow:hidden"><span style="display:block;width:400px">Clipped by its box at the right edge</span></div>
    </body>`);
  const planted = await overflows(page);
  expect(planted.some((fault) => fault.startsWith('cut') && fault.includes('p'))).toBe(true);
  expect(planted.some((fault) => fault.startsWith('past the screen'))).toBe(true);
  expect(planted.some((fault) => fault.startsWith('squeezed'))).toBe(true);
  expect(planted.some((fault) => fault.startsWith('past its box'))).toBe(true);
  expect(planted.some((fault) => fault.startsWith('the page scrolls sideways'))).toBe(true);

  await page.setContent(`
    <body style="margin:0;font:16px sans-serif">
      <nav style="overflow-x:auto;white-space:nowrap;width:300px"><a>Sites</a> <a>Notes</a> <a>Connectors</a> <a>Members</a> <a>Account</a></nav>
      <div style="overflow-x:auto;width:300px"><table style="width:600px"><tr><td>A column that the reader scrolls to</td><td>Another one</td></tr></table></div>
      <p style="width:300px;overflow-wrap:anywhere">${LONG_URL}</p>
      <p style="width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${LONG_URL}</p>
    </body>`);
  expect(await overflows(page)).toEqual([]);
});
