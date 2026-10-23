// The page script of an old copy of Fruitback (0.1.0), as far as FRU-397 needs it: the same guard
// on the page, and a mount obeyed on the channel of before. 0.1.0 knew no relay, so it read the
// worker of any mount from the page, with no session: that is the request the spec looks for.
// `?old-late` starts it after the page script of the current copy, which then holds the page.
(() => {
  const start = () => {
    if (window.__fruitbackPageScript === true) return;
    window.__fruitbackPageScript = true;
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (data === null || typeof data !== 'object' || data.channel !== 'fruitback-extension') return;
      if (data.kind !== 'mount' || typeof data.endpoint !== 'string' || typeof data.clientId !== 'string') return;
      const page = encodeURIComponent(window.location.href);
      void fetch(`${data.endpoint}/feedback?url=${page}&client=${encodeURIComponent(data.clientId)}`).catch(() => {});
    });
    window.postMessage({ channel: 'fruitback-extension', kind: 'ready' }, '*');
  };
  if (!new URLSearchParams(window.location.search).has('old-late')) {
    start();

    return;
  }
  const wait = () => (window.__fruitbackPageScript === true ? start() : setTimeout(wait, 50));
  wait();
})();
