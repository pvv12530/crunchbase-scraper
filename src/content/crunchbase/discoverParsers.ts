export type MoneyValue = {
  value_usd: number | null;
  currency: string;
  value: number;
};

export function extractCellPlainText(cell: Element): string {
  return (cell.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function extractCrunchbaseImageId(url: string): string {
  const s = (url ?? "").trim();
  if (!s) return "";
  // Common patterns:
  // - https://images.crunchbase.com/image/upload/.../<image_id>?...
  // - https://.../image/upload/<transforms>/<image_id>
  // - Any URL whose last path segment is the id
  try {
    const u = new URL(s, window.location.origin);
    const parts = u.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1] ?? "";
    const mLast32 = last.match(/^([a-f0-9]{32})$/i);
    if (mLast32?.[1]) return mLast32[1];
    // Sometimes the last segment is the id with extra suffixes; grab 32-hex inside it.
    const mInner32 = last.match(/([a-f0-9]{32})/i);
    if (mInner32?.[1]) return mInner32[1];
  } catch {
    // ignore
  }
  const m = s.match(/([a-f0-9]{32})/i);
  return m?.[1] ?? "";
}

export function extractAnyImageIdFromElement(el: Element): string {
  const imgs = Array.from(el.querySelectorAll("img[src]")).filter(
    (i): i is HTMLImageElement => i instanceof HTMLImageElement,
  );
  for (const img of imgs) {
    const id = extractCrunchbaseImageId(img.src);
    if (id) return id;
  }
  // Fallback: background-image URLs.
  const styled = Array.from(el.querySelectorAll("*")).filter(
    (n): n is HTMLElement => n instanceof HTMLElement,
  );
  for (const n of styled) {
    const bg = n.style?.backgroundImage ?? "";
    const m = bg.match(/url\(["']?([^"')]+)["']?\)/i);
    const url = m?.[1] ?? "";
    if (!url) continue;
    const id = extractCrunchbaseImageId(url);
    if (id) return id;
  }
  return "";
}

export function parseCrunchbaseOrgPermalinkFromHref(href: string): string | null {
  try {
    const u = new URL(href, window.location.origin);
    const path = u.pathname.replace(/\/+$/, "");
    // Typical patterns:
    // - /organization/<slug>
    // - /organization/<slug>/company_financials
    const m = path.match(/\/organization\/([^/]+)/i);
    if (m?.[1]) return decodeURIComponent(m[1]);
    return null;
  } catch {
    return null;
  }
}

export function parseMoneyValue(raw: string): MoneyValue | null {
  const s = raw.trim();
  if (!s) return null;

  // Common currency symbols and codes.
  // Note: without FX data, we only set value_usd when currency is USD.
  const currencyBySymbol: Record<string, string> = {
    $: "USD",
    "€": "EUR",
    "£": "GBP",
    "¥": "JPY",
    "₩": "KRW",
    "₹": "INR",
  };

  let currency: string | null = null;
  let rest = s;

  const symbol = s[0];
  if (currencyBySymbol[symbol]) {
    currency = currencyBySymbol[symbol];
    rest = s.slice(1).trim();
  } else {
    const codeMatch = s.match(/^(USD|EUR|GBP|JPY|CNY|CAD|AUD|INR|KRW)\b/i);
    if (codeMatch) {
      currency = codeMatch[1].toUpperCase();
      rest = s.slice(codeMatch[0].length).trim();
    }
  }

  if (!currency) return null;

  // Parse number with optional magnitude suffix.
  // Accept: 2,500,000 | 2.5M | 2.5m | 250k | 1.2B
  const magMatch = rest.match(
    /^([0-9][0-9,]*(?:\.[0-9]+)?)\s*([KMB])?$/i,
  );
  if (!magMatch) return null;
  const num = Number(magMatch[1].replace(/,/g, ""));
  if (!Number.isFinite(num)) return null;
  const mag = (magMatch[2] ?? "").toUpperCase();
  const mult = mag === "K" ? 1e3 : mag === "M" ? 1e6 : mag === "B" ? 1e9 : 1;
  const value = Math.round(num * mult);
  const value_usd = currency === "USD" ? value : null;
  return { value_usd, currency, value };
}

export type EntityIdentifier = {
  permalink: string;
  image_id: string;
  uuid: string;
  entity_def_id: "organization" | "person" | string;
  value: string;
};

export function parseEntityIdentifiersFromCell(cell: Element): EntityIdentifier[] {
  const anchors = Array.from(cell.querySelectorAll("a[href]")).filter(
    (a): a is HTMLAnchorElement => a instanceof HTMLAnchorElement,
  );
  const out: EntityIdentifier[] = [];
  for (const a of anchors) {
    const href = a.getAttribute("href") ?? "";
    if (!href) continue;

    let permalink = "";
    let entity_def_id: string = "";
    try {
      const u = new URL(href, window.location.origin);
      const path = u.pathname.replace(/\/+$/, "");
      const mOrg = path.match(/\/organization\/([^/]+)/i);
      const mPerson = path.match(/\/person\/([^/]+)/i);
      if (mOrg?.[1]) {
        permalink = decodeURIComponent(mOrg[1]);
        entity_def_id = "organization";
      } else if (mPerson?.[1]) {
        permalink = decodeURIComponent(mPerson[1]);
        entity_def_id = "person";
      } else {
        const seg = path.split("/").filter(Boolean).pop();
        if (seg) permalink = decodeURIComponent(seg);
      }
    } catch {
      // ignore
    }

    const value = (a.getAttribute("title") ?? a.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!value) continue;

    const img = a.querySelector("img[src]") as HTMLImageElement | null;
    const image_id = extractCrunchbaseImageId(img?.src ?? "");

    const uuid =
      a.getAttribute("data-uuid") ??
      a.closest("[data-uuid]")?.getAttribute("data-uuid") ??
      "";

    out.push({ permalink, image_id, uuid, entity_def_id, value });
  }

  const seen = new Set<string>();
  return out.filter((e) => {
    const k = `${e.entity_def_id}::${e.permalink}::${e.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function normalizeRevenueRangeEnum(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^less than\s*\$?1m$/i.test(s)) return "r_00010000";
  return null;
}

export function normalizeRangeValue(raw: string): string | null {
  const s = raw.trim();
  const m = s.match(/^(\d{1,6})\s*-\s*(\d{1,6})$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const pad = (n: number) => String(Math.trunc(n)).padStart(5, "0");
  return `c_${pad(a)}_${pad(b)}`;
}

