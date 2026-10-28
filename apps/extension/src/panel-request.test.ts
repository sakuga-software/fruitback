import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PANEL_REQUEST_INTERVAL_MS, createPanelGate, hasGesture, openPanelForTab } from './panel-request.ts';
import { parseBridgeMessage } from './protocol.ts';

/** The button of the widget opens the side panel of the browser (FRU-469). */

describe('the side panel asked by the widget (FRU-469)', () => {
  it('opens the panel of the tab of the sender, in the same turn, and says it opened', async () => {
    const calls: unknown[] = [];
    const apis = {
      sidePanel: {
        open: async (where: { tabId?: number }) => {
          calls.push(where);
        },
      },
    };
    const answer = openPanelForTab(apis, 7, () => true);
    // Before any `await`: a browser keeps the gesture of the person only that long.
    assert.deepEqual(calls, [{ tabId: 7 }]);
    assert.equal(await answer, true);
  });

  it('says it did not open for no tab, a tab asked too often, no panel, a refusal or a throw', async () => {
    const refusing = { sidePanel: { open: async () => Promise.reject(new Error('gesture')) } };
    const throwing = {
      sidePanel: {
        open: () => {
          throw new Error('sync');
        },
      },
    };
    const opening = { sidePanel: { open: async () => {} } };
    assert.equal(await openPanelForTab(opening, undefined, () => true), false);
    assert.equal(await openPanelForTab(opening, 7, () => false), false);
    assert.equal(await openPanelForTab({}, 7, () => true), false);
    assert.equal(await openPanelForTab(refusing, 7, () => true), false);
    assert.equal(await openPanelForTab(throwing as never, 7, () => true), false);
  });

  it('falls back to the sidebar of Firefox', async () => {
    let opened = 0;
    assert.equal(
      await openPanelForTab(
        {
          sidebarAction: {
            open: async () => {
              opened += 1;
            },
          },
        },
        7,
        () => true,
      ),
      true,
    );
    assert.equal(opened, 1);
  });

  it('gives the interval back when the panel did not open (review of #648)', async () => {
    const gate = createPanelGate(() => 0);
    const refusing = { sidePanel: { open: async () => Promise.reject(new Error('gesture')) } };
    const opening = { sidePanel: { open: async () => {} } };
    assert.equal(await openPanelForTab(refusing, 3, gate), false);
    assert.equal(await openPanelForTab(opening, 3, gate), true, 'a refusal kept the tab waiting');
    assert.equal(await openPanelForTab(opening, 3, gate), false, 'an opening did not count');
  });

  it('answers a tab once in an interval, and each tab apart', () => {
    let now = 0;
    const gate = createPanelGate(() => now);
    assert.equal(gate(1), true);
    assert.equal(gate(1), false);
    assert.equal(gate(2), true);
    now = PANEL_REQUEST_INTERVAL_MS;
    assert.equal(gate(1), true);
  });

  it('is carried only while the window holds the activation of a gesture (review of #648)', () => {
    assert.equal(hasGesture({ userActivation: { isActive: true } }), true);
    assert.equal(hasGesture({ userActivation: { isActive: false } }), false);
    // A browser that does not say: no.
    assert.equal(hasGesture({}), false);
  });

  it('carries an id across the bridge, and nothing else', () => {
    assert.deepEqual(
      parseBridgeMessage({ channel: 'fruitback-extension/2', kind: 'open-panel-request', id: 'p1', tabId: 99 }),
      { channel: 'fruitback-extension/2', kind: 'open-panel-request', id: 'p1' },
    );
    assert.deepEqual(
      parseBridgeMessage({ channel: 'fruitback-extension/2', kind: 'open-panel-response', id: 'p1', opened: 'yes' }),
      { channel: 'fruitback-extension/2', kind: 'open-panel-response', id: 'p1', opened: false },
    );
  });
});
