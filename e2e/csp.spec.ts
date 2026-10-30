import { expect, test } from '@playwright/test';
import { caseOf } from './pin.ts';

/**
 * A page whose CSP refuses inline styles (FRU-522). Kentō sends `style-src 'self'`, and there the
 * widget showed the browser's own buttons: the page refused each `<style>` element of the Shadow root.
 * The playground keeps its scripts, so the policy names only the styles.
 *
 * The spec waits for no pin count. Chromium gives a document that `route.fulfill` wrote no address
 * space, and Local Network Access then refuses its calls to the worker on the loopback.
 */
test('the widget keeps its styles on a page whose CSP refuses inline styles', async ({ page }) => {
  const refused: string[] = [];
  await page.exposeFunction('reportViolation', (directive: string) => refused.push(directive));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as unknown as { reportViolation(directive: string): void }).reportViolation(event.effectiveDirective);
    });
  });
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.fallback();
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'content-security-policy': "style-src 'self'" },
    });
  });

  await page.goto(`/?case=${caseOf('csp-styles')}`);

  const launch = page.getByRole('button', { name: /Leave feedback/ });
  await expect(launch).toBeVisible();
  const styles = await launch.evaluate((node) => {
    const computed = getComputedStyle(node);

    return { fontSize: computed.fontSize, borderStyle: computed.borderStyle };
  });
  // The control: the policy is in force, and it refuses the inline styles of the playground itself.
  expect(refused).toContain('style-src-elem');
  // The browser's own button is 13.33 px with an outset border.
  expect(styles).toEqual({ fontSize: '13px', borderStyle: 'solid' });

  // The composer comes after the mount. A host outside the Shadow root at that time gets the
  // fallback <style>, which this policy refuses.
  await launch.click();
  await page.locator('#checkout-cta').click();
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeVisible();
  expect(await send.evaluate((node) => getComputedStyle(node).borderStyle)).toBe('solid');
  const elements = await page.evaluate(
    () => document.querySelector('[data-fruitback-host]')?.shadowRoot?.querySelectorAll('style').length,
  );
  expect(elements).toBe(0);
});
