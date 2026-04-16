export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export function getScrollParent(el: Element | null): HTMLElement | null {
  let cur: Element | null = el;
  for (let i = 0; i < 12 && cur; i++) {
    if (cur instanceof HTMLElement) {
      const style = window.getComputedStyle(cur);
      const overflowY = style.overflowY;
      const canScroll =
        (overflowY === "auto" || overflowY === "scroll") &&
        cur.scrollHeight > cur.clientHeight + 4;
      if (canScroll) return cur;
    }
    cur = cur.parentElement;
  }
  return null;
}

export function getByTagName<T extends Element>(
  root: ParentNode,
  tag: string,
): T[] {
  return Array.from(root.querySelectorAll(tag)) as T[];
}

export function isElementDisplayed(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none") return false;
  if (style.visibility === "hidden") return false;
  if (style.opacity === "0") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function findOpenMenuPanel(menuPanelSelectors: string[]): HTMLElement | null {
  const selector = menuPanelSelectors.join(",");
  const candidates = Array.from(document.querySelectorAll(selector));
  for (const c of candidates) {
    if (isElementDisplayed(c)) return c;
  }
  return null;
}

export async function waitForElement(
  selector: string,
  opts: {
    timeoutMs: number;
    pollMs?: number;
    root?: ParentNode;
    signal?: AbortSignal;
  },
): Promise<Element> {
  const pollMs = opts.pollMs ?? 120;
  const root = opts.root ?? document;
  const started = Date.now();
  while (Date.now() - started < opts.timeoutMs) {
    if (opts.signal?.aborted) {
      const err = new Error("Cancelled by user");
      err.name = "AbortError";
      throw err;
    }
    const el = root.querySelector(selector);
    if (el) return el;
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for ${selector}`);
}

export function clickRadioByLabel(root: ParentNode, labelText: string): boolean {
  const want = normalizeText(labelText);
  const labels = Array.from(root.querySelectorAll("label"));
  for (const l of labels) {
    if (!(l instanceof HTMLLabelElement)) continue;
    if (normalizeText(l.textContent ?? "") !== want) continue;
    const forId = l.getAttribute("for");
    if (forId) {
      const input = root.querySelector(`#${CSS.escape(forId)}`);
      if (input instanceof HTMLInputElement) {
        input.click();
        return true;
      }
    }
    const radio = l.querySelector('input[type="radio"]');
    if (radio instanceof HTMLInputElement) {
      radio.click();
      return true;
    }
    const btn = l.closest("mat-radio-button");
    if (btn instanceof HTMLElement) {
      btn.click();
      return true;
    }
  }
  return false;
}

export function setInputValue(
  el: HTMLInputElement,
  value: string,
  opts?: { blur?: boolean },
): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proto = (el as any).__proto__ as { value?: unknown } | undefined;
    const desc = proto ? Object.getOwnPropertyDescriptor(proto, "value") : undefined;
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
  } catch {
    el.value = value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  if (opts?.blur ?? true) el.dispatchEvent(new Event("blur", { bubbles: true }));
}

export function clickElement(el: Element): void {
  if (el instanceof HTMLElement) {
    el.click();
    return;
  }
  (el as unknown as { click?: () => void }).click?.();
}

export function findButtonLikeByText(
  root: ParentNode,
  text: string,
): HTMLElement | null {
  const want = normalizeText(text);
  const els = Array.from(root.querySelectorAll("button,[role='menuitem']"));
  for (const el of els) {
    if (!(el instanceof HTMLElement)) continue;
    const t = normalizeText(el.textContent ?? "");
    if (!t) continue;
    if (t === want || t.includes(want)) return el;
  }
  return null;
}

export async function waitForCheckboxChecked(
  input: HTMLInputElement,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < opts.timeoutMs) {
    if (opts.signal?.aborted) {
      const err = new Error("Cancelled by user");
      err.name = "AbortError";
      throw err;
    }
    if (input.checked) return true;
    await sleep(50);
  }
  return input.checked;
}

