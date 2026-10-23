// The bridge of an old copy: it says the decision of its own rule on the channel of before, when
// it starts and when a page script says `ready`. Its rule is a private one, on the first worker.
(() => {
  const mount = () =>
    window.postMessage(
      { channel: 'fruitback-extension', kind: 'mount', endpoint: 'http://localhost:8788', clientId: 'old-copy' },
      window.location.origin,
    );
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data !== null && typeof data === 'object' && data.channel === 'fruitback-extension' && data.kind === 'ready') {
      mount();
    }
  });
  mount();
})();
