import { useEffect, useRef, useState } from "react";
import type { DelayKey, DelaySettings } from "@shared/delaySettings";
import {
  DEFAULT_DELAYS,
  ensurePersistedDelaySettingsInitialized,
  loadPersistedDelaySettings,
  savePersistedDelaySettings,
} from "@shared/delaySettings";

function delayLabel(key: DelayKey): string {
  const s = String(key);
  return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/Ms$/i, " (ms)");
}

export function DelaySettingsPanel(props: {
  btnBaseClassName: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [delaySettings, setDelaySettings] = useState<DelaySettings>(() => ({
    ...DEFAULT_DELAYS,
  }));
  const hydratedOnce = useRef(false);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    void (async () => {
      if (hydratedOnce.current) return;
      hydratedOnce.current = true;
      await ensurePersistedDelaySettingsInitialized();
      const restored = await loadPersistedDelaySettings();
      setDelaySettings(restored);
    })();
  }, []);

  useEffect(() => {
    if (!hydratedOnce.current) return;
    if (saveTimer.current != null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void savePersistedDelaySettings(delaySettings);
    }, 250);
    return () => {
      if (saveTimer.current != null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
    };
  }, [delaySettings]);

  return (
    <section className="mb-3 rounded-[10px] border border-[#2a3140] bg-[#161a22] p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-xs font-medium text-[#9aa3b2]">Settings</h2>
        <button
          type="button"
          className={props.btnBaseClassName}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide" : "Show"}
        </button>
      </div>

      {open ? (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="m-0 text-[11px] text-[#9aa3b2]">
              Delay per activity (milliseconds).
            </p>
            <button
              type="button"
              className={props.btnBaseClassName}
              onClick={() => setDelaySettings({ ...DEFAULT_DELAYS })}
              title="Restore defaults"
            >
              Reset defaults
            </button>
          </div>

          <div className="grid grid-cols-1 gap-2">
            {(Object.keys(DEFAULT_DELAYS) as DelayKey[]).map((k) => {
              const val = delaySettings[k];
              return (
                <label
                  key={k}
                  className="flex items-center justify-between gap-3 rounded-lg border border-[#2a3140] bg-[#12151c] px-3 py-2"
                >
                  <span className="text-[11px] text-[#b8c0cc]">
                    {delayLabel(k)}
                  </span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step={50}
                    className="w-[140px] rounded-md border border-[#2a3140] bg-[#0f1115] px-2 py-1 text-[11px] text-[#e8eaef] outline-none focus:border-[#4c8bf5]/60"
                    value={Number.isFinite(val) ? String(val) : "0"}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      setDelaySettings((prev) => ({
                        ...prev,
                        [k]: Number.isFinite(n) ? n : 0,
                      }));
                    }}
                  />
                </label>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}

