export const DELAY_SETTINGS_PERSIST_KEY =
  "crunchbaseDateBatch.delaysByActivity.v1";

export const DEFAULT_DELAYS = {
  afterFinancialsClickMs: 1_650,
  afterCustomClickMs: 1_450,
  afterSetDatesMs: 650,
  afterDatesResultsLoadMs: 10_000,
  afterSettingsClickMs: 2_500,
  afterMenuOpenMs: 2_500,
  afterToggleColumnMs: 2_000,
  afterApplyViewMs: 1_000,
  beforeNextClickMs: 30_000,
  afterNextClickMs: 16_000,
  afterApplyFiltersWaitMs: 20_000,
  // Long pause between dates to avoid rate limits (10 minutes by default).
  betweenDatesMs: 600_000,

  // Timeouts / waits (multi-second) that were previously hard-coded.
  tabLoadTimeoutMs: 60_000,
  tabUrlWaitTimeoutMs: 60_000,
  resultsRootWaitMs: 20_000,
  settingsButtonWaitMs: 15_000,
  settingsMenuWaitMs: 8_000,
  editViewDialogWaitMs: 10_000,
  editViewFilterInputWaitMs: 10_000,
  financialsOverlayWaitMs: 6_500,

  // Search API capture timing.
  searchApiCaptureTimeoutMs: 90_000,
  searchApiCapturePollMs: 1_250,

  // Background wait logging cadence.
  betweenDatesLogTickMs: 15_000,

  // After opening/navigating the Discover tab, wait before starting UI automation.
  // Helps Crunchbase finish rendering/hydration before we click Settings / Edit table view.
  afterTabLoadBeforeConfigureMs: 10_000,

  // If we detect a rate limit response from the search API, cool down and retry the same date.
  rateLimitCooldownMs: 600_000,
} as const;

export type DelayKey = keyof typeof DEFAULT_DELAYS;
export type DelaySettings = Record<DelayKey, number>;

function clampDelayMs(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(10 * 60_000, Math.max(0, Math.round(n)));
}

export function normalizeDelaySettings(input: unknown): DelaySettings {
  const obj =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const out = { ...DEFAULT_DELAYS } as DelaySettings;
  for (const k of Object.keys(DEFAULT_DELAYS) as DelayKey[]) {
    const v = obj[k];
    if (typeof v === "number") out[k] = clampDelayMs(v);
    else if (typeof v === "string" && v.trim() !== "") {
      const parsed = Number(v);
      if (Number.isFinite(parsed)) out[k] = clampDelayMs(parsed);
    }
  }
  return out;
}

export async function loadPersistedDelaySettings(): Promise<DelaySettings> {
  try {
    if (chrome?.storage?.local) {
      const res = (await chrome.storage.local.get(
        DELAY_SETTINGS_PERSIST_KEY,
      )) as Record<string, unknown>;
      return normalizeDelaySettings(res?.[DELAY_SETTINGS_PERSIST_KEY]);
    }
  } catch {
    // ignore and fall back
  }
  try {
    const raw = localStorage.getItem(DELAY_SETTINGS_PERSIST_KEY);
    if (!raw) return { ...DEFAULT_DELAYS };
    return normalizeDelaySettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_DELAYS };
  }
}

export async function savePersistedDelaySettings(
  next: DelaySettings,
): Promise<void> {
  const normalized = normalizeDelaySettings(next);
  try {
    if (chrome?.storage?.local) {
      await chrome.storage.local.set({
        [DELAY_SETTINGS_PERSIST_KEY]: normalized,
      });
      return;
    }
  } catch {
    // ignore and fall back
  }
  try {
    localStorage.setItem(
      DELAY_SETTINGS_PERSIST_KEY,
      JSON.stringify(normalized),
    );
  } catch {
    // ignore
  }
}

/**
 * Ensures initial delay defaults exist in storage on first run / install.
 * Does not overwrite existing values.
 */
export async function ensurePersistedDelaySettingsInitialized(): Promise<void> {
  try {
    if (chrome?.storage?.local) {
      const res = (await chrome.storage.local.get(
        DELAY_SETTINGS_PERSIST_KEY,
      )) as Record<string, unknown>;
      if (res?.[DELAY_SETTINGS_PERSIST_KEY] == null) {
        await chrome.storage.local.set({
          [DELAY_SETTINGS_PERSIST_KEY]: { ...DEFAULT_DELAYS },
        });
      }
      return;
    }
  } catch {
    // ignore and fall back
  }
  try {
    const existing = localStorage.getItem(DELAY_SETTINGS_PERSIST_KEY);
    if (existing == null) {
      localStorage.setItem(
        DELAY_SETTINGS_PERSIST_KEY,
        JSON.stringify(DEFAULT_DELAYS),
      );
    }
  } catch {
    // ignore
  }
}
