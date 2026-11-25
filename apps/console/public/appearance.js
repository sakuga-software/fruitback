// The appearance a person chose (FRU-694), written on <html> before the first paint, so the page
// never shows the default theme first and the chosen one after. app/appearance.ts keeps the choice
// and the variables of its light and dark themes; this file only writes the ones of the mode on
// screen. It knows no theme. A storage that throws, or a value that is not what it expects, writes
// nothing: the page keeps the default theme.
(function () {
  try {
    var kept = JSON.parse(localStorage.getItem('fruitback.appearance') || 'null');
    if (!kept || typeof kept !== 'object' || !kept.appearance) return;
    var mode = kept.appearance.mode;
    var dark = mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    var written = dark ? kept.dark : kept.light;
    if (!written || typeof written !== 'object') return;
    var style = document.documentElement.style;
    for (var name in written) {
      if (/^--[a-z0-9-]+$/.test(name) && typeof written[name] === 'string') style.setProperty(name, written[name]);
    }
  } catch {
    // The default theme.
  }
})();
