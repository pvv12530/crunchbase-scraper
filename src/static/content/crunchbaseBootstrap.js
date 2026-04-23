(() => {
  // Classic-script bootstrap for MV3 content scripts.
  // Loads the real (bundled) content script as an ES module via dynamic import.
  try {
    // Avoid double-bootstrapping on SPA navigations / reinjection.
    if (globalThis.__crunchbaseDateBatchBootstrapLoaded) return;
    globalThis.__crunchbaseDateBatchBootstrapLoaded = true;
  } catch {
    // ignore
  }

  try {
    const url = chrome?.runtime?.getURL
      ? chrome.runtime.getURL("content/crunchbase.js")
      : null;
    if (!url) {
      // eslint-disable-next-line no-console
      console.warn("[crunchbase-date-batch] bootstrap: chrome.runtime.getURL unavailable");
      return;
    }

    // Dynamic import executes the module in the extension isolated world.
    // If this fails, the background/panel logs will show it via console.
    import(url).catch((e) => {
      // eslint-disable-next-line no-console
      console.error("[crunchbase-date-batch] bootstrap: failed to import content/crunchbase.js", e);
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[crunchbase-date-batch] bootstrap: unexpected error", e);
  }
})();

