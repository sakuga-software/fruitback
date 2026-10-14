// Usage: node capture.cjs <pagesDir> <shotsDir> <renderedDir> <playwrightModule>
const [pagesDir, shotsDir, renderedDir, pwPath] = process.argv.slice(2);
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const { chromium } = require(pwPath);
const SCREENS = [
  ['01', 'setup', 'step', ['email', 'sent', 'site', 'install', 'first-note']],
  ['02', 'sign-in', 'state', ['sign-in', 'sent', 'link-opened', 'expired']],
  ['03', 'invitation', 'state', ['invitation', 'joined']],
  ['04', 'connect-browser', 'state', ['ask', 'signed-out', 'connected']],
  ['05', 'popup-signed-out', null, ['default']],
  ['06', 'popup-site-in-workspace', null, ['default']],
  ['07', 'popup-on', null, ['default']],
  ['08', 'popup-new-site', null, ['default']],
  ['09', 'console-sites', 'state', ['list', 'empty', 'failed']],
  ['10', 'console-notes', null, ['default']],
  ['11', 'console-connectors', null, ['default']],
  ['12', 'console-members', null, ['default']],
  ['13', 'console-account', null, ['default']],
  ['14', 'widget-reading', null, ['default']],
  ['15', 'widget-leaving', null, ['default']],
  ['16', 'widget-all-notes', null, ['default']],
  ['17', 'admin-instance', null, ['default']],
  ['18', 'admin-workspaces', null, ['default']],
  ['19', 'admin-users', null, ['default']],
  ['20', 'admin-notes', null, ['default']],
];
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);
(async () => {
  const files = fs.readdirSync(pagesDir).filter((f) => f.endsWith('.html')).sort();
  const browser = await chromium.launch({ headless: true });
  const outbound = []; const consoleMsgs = []; const index = []; const meta = {};
  async function open(file, width, height, opts = {}) {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: opts.dark ? 'dark' : 'light', reducedMotion: opts.reduced ? 'reduce' : 'no-preference', serviceWorkers: 'block' });
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith('file:') || u.startsWith('blob:') || u.startsWith('data:') || u.startsWith('about:')) return route.continue();
      outbound.push({ file, url: u, type: route.request().resourceType() }); return route.abort('blockedbyclient');
    });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) consoleMsgs.push({ file, type: m.type(), text: m.text().slice(0, 300) }); });
    page.on('pageerror', (e) => consoleMsgs.push({ file, type: 'pageerror', text: String(e).slice(0, 300) }));
    await page.goto('file://' + path.join(pagesDir, file));
    await page.waitForFunction(() => typeof window.__dcRootName === 'function' && document.querySelector('#dc-root') && document.querySelector('#dc-root').children.length > 0, null, { timeout: 30000 });
    await page.waitForTimeout(600);
    return { ctx, page };
  }
  async function setState(page, prop, value) {
    if (!prop) return;
    await page.evaluate(([p, v]) => window.__dcSetProps(window.__dcRootName(), { [p]: v }), [prop, value]);
    await page.waitForTimeout(350);
  }
  async function shot(page, name) {
    const buf = await page.screenshot({ fullPage: true, animations: 'disabled' });
    fs.writeFileSync(path.join(shotsDir, name), buf);
    const dims = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight, vw: innerWidth }));
    index.push({ name, ...dims, sha: sha(buf) }); return buf;
  }
  for (const [num, slug, prop, states] of SCREENS) {
    const file = files.find((f) => f.startsWith(num + '-'));
    const isPopup = slug.startsWith('popup');
    for (const width of [1440, 390].concat(isPopup ? [360] : [])) {
      const h = { 1440: 900, 390: 844 }[width] ?? 600;
      const { ctx, page } = await open(file, width, h);
      for (const st of states) {
        await setState(page, prop, st);
        await shot(page, `${num}-${slug}-${st}-${width}.png`);
        if (width === 1440 || (isPopup && width === 360)) {
          // rendered DOM + measurements
          const data = await page.evaluate(() => {
            const root = document.querySelector('#dc-root');
            const lum = (c) => { const a = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]; };
            const parse = (s) => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map(Number); return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; };
            const hex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
            const bgOf = (el) => { let stack = []; for (let e = el; e; e = e.parentElement) { const b = parse(getComputedStyle(e).backgroundColor); if (b && b.a > 0) { stack.push(b); if (b.a === 1) break; } } let base = [255, 255, 255]; for (const b of stack.reverse()) base = base.map((v, i) => v * (1 - b.a) + b.rgb[i] * b.a); return base; };
            const pairs = new Map(); const els = [];
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) { const n = walker.currentNode; const txt = n.nodeValue.trim(); if (!txt) continue; const el = n.parentElement; const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden') continue; if (r.width <= 1 && r.height <= 1) continue; const fg = parse(cs.color); const bg = bgOf(el); const fgc = fg.rgb.map((v, i) => v * fg.a + bg[i] * (1 - fg.a)); const L1 = lum(fgc), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); const key = [hex(fgc), hex(bg), cs.fontSize, cs.fontWeight].join('|'); if (!pairs.has(key)) pairs.set(key, { fg: hex(fgc), bg: hex(bg), size: cs.fontSize, weight: cs.fontWeight, ratio: Math.round(ratio * 100) / 100, sample: txt.slice(0, 50), n: 0 }); pairs.get(key).n++; }
            for (const el of root.querySelectorAll('h1,h2,h3,button,a,input,select,textarea,[role],table,th,img,svg,label,nav,header,main,aside,section,footer,dialog,details,summary')) { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); els.push({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), aria: [...el.attributes].filter((a) => a.name.startsWith('aria-')).map((a) => a.name + '=' + a.value).join(' '), cls: el.className && el.className.baseVal === undefined ? el.className : '', text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 90), x: Math.round(r.x), y: Math.round(r.y + scrollY), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, font: cs.fontSize + '/' + cs.lineHeight + ' ' + cs.fontWeight, radius: cs.borderRadius }); }
            return { html: root.innerHTML, pairs: [...pairs.values()], els, title: document.title, lang: document.documentElement.lang };
          });
          fs.writeFileSync(path.join(renderedDir, `${num}-${slug}-${st}.html`), data.html);
          meta[`${num}-${slug}-${st}@${width}`] = { title: data.title, lang: data.lang, contrast: data.pairs, els: data.els };
        }
      }
      // interactive states on the last state shown? reset to first state for hover/focus
      await setState(page, prop, states[0]);
      // focus: first Tab stops
      await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => { const a = document.activeElement; return a ? a.tagName + ':' + (a.innerText || a.getAttribute('aria-label') || a.getAttribute('placeholder') || '').trim().slice(0, 40) : null; });
      await shot(page, `${num}-${slug}-${states[0]}-focus2-${width}.png`); index[index.length - 1].note = 'focus après 2 Tab : ' + focused;
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      // hover on each kind of hover class (first visible)
      for (const cls of ['b-accent', 'b-ext', 'b-wide', 'b-link', 'b-ghost', 'b-icon', 'b-danger', 'nav-link', 'row', 'chip', 'pick', 'note', 'pin']) {
        const loc = page.locator('.' + cls + ':visible').first();
        if (await loc.count() === 0) continue;
        try { await loc.scrollIntoViewIfNeeded({ timeout: 2000 }); await loc.hover({ timeout: 2000 }); await page.waitForTimeout(120);
          const box = await loc.boundingBox(); const pad = 24;
          const buf = await page.screenshot({ animations: 'disabled', clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: Math.min(box.width + 2 * pad, width), height: box.height + 2 * pad } });
          const name = `${num}-${slug}-${states[0]}-hover-${cls}-${width}.png`; fs.writeFileSync(path.join(shotsDir, name), buf); index.push({ name, w: Math.round(box.width), h: Math.round(box.height), vw: width, sha: sha(buf), note: 'détail au survol de .' + cls });
        } catch (e) { index.push({ name: `(échec survol .${cls} ${num} ${width})`, note: String(e).slice(0, 80) }); }
      }
      await page.mouse.move(0, 0);
      // switches toggled
      const sw = page.locator('.switch:visible');
      const nsw = await sw.count();
      if (nsw > 0) { for (let i = 0; i < nsw; i++) await sw.nth(i).click({ force: true }); await page.waitForTimeout(400); await shot(page, `${num}-${slug}-${states[0]}-switches-inverted-${width}.png`); index[index.length - 1].note = nsw + ' interrupteur(s) inversé(s)'; }
      await ctx.close();
    }
    // dark + reduced-motion probes (1440 only): compare with light
    const a = await open(file, 1440, 900); const lightBuf = await a.page.screenshot({ fullPage: true, animations: 'disabled' }); await a.ctx.close();
    const d = await open(file, 1440, 900, { dark: true }); const darkBuf = await d.page.screenshot({ fullPage: true, animations: 'disabled' }); await d.ctx.close();
    meta[`${num}-${slug}@probe`] = { darkIdenticalToLight: sha(lightBuf) === sha(darkBuf) };
    if (sha(lightBuf) !== sha(darkBuf)) fs.writeFileSync(path.join(shotsDir, `${num}-${slug}-${states[0]}-dark-1440.png`), darkBuf);
    console.log('done', num, slug);
  }
  await browser.close();
  fs.writeFileSync(path.join(renderedDir, 'capture-index.json'), JSON.stringify(index, null, 1));
  fs.writeFileSync(path.join(renderedDir, 'measures.json'), JSON.stringify(meta, null, 1));
  fs.writeFileSync(path.join(renderedDir, 'network-and-console.json'), JSON.stringify({ outbound, consoleMsgs }, null, 1));
  console.log('shots', index.length, 'outbound', outbound.length, 'console', consoleMsgs.length);
})().catch((e) => { console.error(e); process.exit(1); });
