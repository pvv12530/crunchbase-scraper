/** Injected into page context to capture JSON from fetch responses (MAIN world). */
export const PAGE_HOOK_SOURCE = 'crunchbase-date-batch-hook';

export function buildPageHookInlineScript(): string {
  const source = PAGE_HOOK_SOURCE;
  return `(() => {
    const SRC = ${JSON.stringify(source)};
    if (window[SRC]) return;
    window[SRC] = true;

    function maybeEmit(url, body) {
      try {
        const u = typeof url === 'string' ? url : String(url);
        if (!u.includes('crunchbase')) return;
        if (u.includes('graphql') || u.includes('/v4/') || u.includes('api.crunchbase.com')) {
          window.postMessage({ source: SRC, kind: 'json', url: u, body }, '*');
        }
      } catch (e) {}
    }

    const origFetch = window.fetch;
    window.fetch = function (...args) {
      return origFetch.apply(this, args).then((res) => {
        try {
          const req = args[0];
          const url = typeof req === 'string' ? req : req && req.url ? req.url : '';
          const clone = res.clone();
          clone
            .json()
            .then((body) => maybeEmit(url, body))
            .catch(() => {});
        } catch (e) {}
        return res;
      });
    };

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.addEventListener('load', function () {
        try {
          const ct = this.getResponseHeader('content-type') || '';
          if (!ct.includes('json')) return;
          const txt = this.responseText;
          if (!txt || txt.length > 5_000_000) return;
          const body = JSON.parse(txt);
          maybeEmit(String(url), body);
        } catch (e) {}
      });
      return origOpen.apply(this, arguments);
    };
  })();`;
}

export function injectPageHook(): void {
  const el = document.createElement('script');
  el.textContent = buildPageHookInlineScript();
  (document.head || document.documentElement).appendChild(el);
  el.remove();
}
