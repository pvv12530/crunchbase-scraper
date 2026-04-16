// Runs in the *page* (MAIN) world via <script src="chrome-extension://..."> injection.
// Captures Crunchbase JSON API responses and posts them back to the content script.
(() => {
  const SRC = "crunchbase-date-batch-hook";
  const w = window as unknown as Record<string, unknown>;
  if (w[SRC]) return;
  w[SRC] = true;

  const isOrgPreviewUrl = (u: string): boolean =>
    /\/v4\/data\/entities\/organizations\/[^/?#]+/i.test(u) &&
    /layout_mode=preview/i.test(u);

  const post = (url: string, body: unknown) => {
    try {
      if (!isOrgPreviewUrl(url)) return;
      window.postMessage({ source: SRC, kind: "orgPreview", url, body }, "*");
    } catch {
      // ignore
    }
  };

  // fetch interception
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (...args: unknown[]) {
      const req = args[0] as unknown;
      let url = "";
      try {
        url =
          typeof req === "string"
            ? req
            : req && typeof req === "object" && "url" in (req as object)
              ? String((req as { url?: unknown }).url ?? "")
              : "";
      } catch {
        url = "";
      }
      return (origFetch as (...a: unknown[]) => Promise<Response>)
        .apply(this, args)
        .then((res) => {
          try {
            if (url && isOrgPreviewUrl(url)) {
              const clone = res.clone();
              clone
                .json()
                .then((body) => post(url, body))
                .catch(() => {});
            }
          } catch {
            // ignore
          }
          return res;
        });
    };
  }

  // XHR interception
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method: string, url: string | URL) {
    try {
      (this as unknown as { __cbUrl?: string }).__cbUrl = String(url ?? "");
    } catch {
      // ignore
    }
    // eslint-disable-next-line prefer-rest-params
    return origOpen.apply(this, arguments as any);
  };

  XMLHttpRequest.prototype.send = function (...args: unknown[]) {
    try {
      this.addEventListener("load", function () {
        try {
          const url = String(
            (this as unknown as { __cbUrl?: string }).__cbUrl ?? "",
          );
          if (!url || !isOrgPreviewUrl(url)) return;
          const txt = this.responseText;
          if (!txt || txt.length > 5_000_000) return;
          post(url, JSON.parse(txt));
        } catch {
          // ignore
        }
      });
    } catch {
      // ignore
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    return origSend.apply(this, args as any);
  };
})();

