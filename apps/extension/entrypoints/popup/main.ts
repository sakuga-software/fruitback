import { browser } from 'wxt/browser';
import { type SiteConfig, readSite, writeSite } from '../../src/sites.ts';

/**
 * The switch for the tab you are looking at, and the two fields that make it work (SKG-534).
 *
 * Deliberately not the editor for every site — that is SKG-536, which owns the options page. This is
 * the one question a reviewer asks from the toolbar: is Fruitback on here, and against which worker.
 *
 * There is no framework in this popup on purpose. It is four elements, it opens and closes in under
 * a second, and a bundle for it would be larger than everything it renders.
 */

const app = document.querySelector('#app');

void render();

async function render(): Promise<void> {
  if (app === null) return;

  const tab = await currentTab();
  const origin = originOf(tab?.url);

  if (origin === undefined) {
    // A `chrome://` page, the store, a PDF viewer. Nothing is wrong, and saying so is better than an
    // enabled-looking switch that silently does nothing.
    app.textContent = 'Fruitback works on http and https pages.';

    return;
  }

  const site = await readSite(origin);

  app.replaceChildren(
    element('h1', 'Fruitback'),
    element('p', origin, 'origin'),
    site === undefined ? form(origin) : status(origin, site),
  );
}

/** No entry yet: ask for the two things `init` cannot be called without. */
function form(origin: string): HTMLElement {
  const endpoint = field('Worker endpoint', 'https://feedback.acme.dev');
  const clientId = field('Client id', 'acme');
  const save = element('button', 'Turn on for this site');

  save.addEventListener('click', () => {
    const values = { endpoint: endpoint.input.value.trim(), clientId: clientId.input.value.trim() };
    // Refused rather than stored: an entry missing either one would read as configured and mount
    // nothing, which is the failure that looks like a broken extension.
    if (values.endpoint === '' || values.clientId === '') return;

    void turnOn(origin, values);
  });

  const wrapper = document.createElement('div');
  wrapper.append(endpoint.label, clientId.label, save);

  return wrapper;
}

/**
 * Ask for this origin, then store it.
 *
 * **The request has to come first, and it has to come from this click.** A host permission may only
 * be asked for while a user gesture is being handled, so anything awaited before it — a storage read
 * — loses the gesture and the prompt never appears. And storing first would leave an entry that says
 * "on" for a site the background can never register, which reads as a broken extension.
 */
async function turnOn(origin: string, values: { endpoint: string; clientId: string }): Promise<void> {
  const granted = await browser.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) return;

  await writeSite(origin, { ...values, enabled: true });
  await render();
}

/** Configured: the switch, and what it is switching. */
function status(origin: string, site: SiteConfig): HTMLElement {
  const toggle = element('button', site.enabled ? 'Turn off here' : 'Turn on here');
  toggle.addEventListener('click', () => {
    if (site.enabled) {
      void writeSite(origin, { ...site, enabled: false }).then(render);

      return;
    }

    void turnOn(origin, { endpoint: site.endpoint, clientId: site.clientId });
  });

  const row = document.createElement('div');
  row.className = 'row';
  row.append(element('span', site.enabled ? `On · ${site.clientId}` : `Off · ${site.clientId}`, 'state'), toggle);

  return row;
}

function field(label: string, placeholder: string): { label: HTMLLabelElement; input: HTMLInputElement } {
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = placeholder;

  const wrapper = document.createElement('label');
  wrapper.append(label, input);

  return { label: wrapper, input };
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className !== undefined) node.className = className;

  return node;
}

async function currentTab(): Promise<{ url?: string } | undefined> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });

  return tab;
}

/**
 * The origin, or nothing when the widget could not run there anyway.
 *
 * Restricted to the two schemes a content script is allowed on, so the popup never offers a switch
 * for a page the extension cannot reach.
 */
export function originOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;

  try {
    const parsed = new URL(url);

    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}
