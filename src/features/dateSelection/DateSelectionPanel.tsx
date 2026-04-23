import { Upload } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type { ExtensionMessage } from "@shared/messages";
import { Calendar } from "../../components/Calendar";
import type { DateSourceMode } from "./dateSelection";

export function DateSelectionPanel(props: {
  btnBaseClassName: string;
  mode: DateSourceMode;
  onModeChange: (next: DateSourceMode) => void;
  selectedDateKey: string;
  onSelectedDateKeyChange: (dk: string) => void;
  selectedDateKeys: string[];
  onSelectedDateKeysChange: (next: string[]) => void;
  importedDateOrder: string[];
  onImportedDateOrderChange: (next: string[]) => void;
}): JSX.Element {
  const [csvHint, setCsvHint] = useState("");
  const [csvDragOver, setCsvDragOver] = useState(false);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const csvDragDepth = useRef(0);

  const applyCsvText = useCallback(
    async (text: string) => {
      const res = (await chrome.runtime.sendMessage({
        type: "import/csv",
        text,
      } satisfies ExtensionMessage)) as { dates?: string[]; error?: string };

      if (res.error) {
        setCsvHint(res.error);
        return;
      }

      const dates = res.dates ?? [];
      props.onImportedDateOrderChange(dates);

      if (dates.length > 0) {
        const first = dates[0];
        if (first) props.onSelectedDateKeyChange(first);
        setCsvHint(
          `Imported ${dates.length} date${dates.length === 1 ? "" : "s"} from CSV (not queued — click Scrape to run).`,
        );
      } else {
        setCsvHint("No dates found in CSV.");
      }

      props.onSelectedDateKeysChange(dates);
      props.onModeChange("csv");
    },
    [props],
  );

  const onCsvInputChange = async (ev: React.ChangeEvent<HTMLInputElement>) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    await applyCsvText(text);
    ev.target.value = "";
  };

  const onCsvDropZoneDrop = (ev: React.DragEvent) => {
    ev.preventDefault();
    csvDragDepth.current = 0;
    setCsvDragOver(false);
    const file = ev.dataTransfer.files?.[0];
    if (!file) return;
    void (async () => {
      const text = await file.text();
      await applyCsvText(text);
    })();
  };

  return (
    <>
      <div
        className="mb-3 flex rounded-lg border border-[#2a3140] bg-[#12151c] p-0.5"
        role="tablist"
        aria-label="Date source"
      >
        <button
          type="button"
          role="tab"
          aria-selected={props.mode === "calendar"}
          className={[
            "flex-1 rounded-md px-3 py-2 text-xs font-medium transition-colors",
            props.mode === "calendar"
              ? "bg-[#4c8bf5] text-white"
              : "text-[#9aa3b2] hover:text-[#e8eaef]",
          ].join(" ")}
          onClick={() => props.onModeChange("calendar")}
        >
          Calendar
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={props.mode === "csv"}
          className={[
            "flex-1 rounded-md px-3 py-2 text-xs font-medium transition-colors",
            props.mode === "csv"
              ? "bg-[#4c8bf5] text-white"
              : "text-[#9aa3b2] hover:text-[#e8eaef]",
          ].join(" ")}
          onClick={() => props.onModeChange("csv")}
        >
          CSV
        </button>
      </div>

      {props.mode === "calendar" ? (
        <Calendar
          value={props.selectedDateKeys}
          onChange={(next) => {
            props.onSelectedDateKeysChange(next);
            if (next[0])
              props.onSelectedDateKeyChange(next[next.length - 1] ?? next[0]);
          }}
          onActiveDateKeyChange={(dk) => {
            props.onSelectedDateKeyChange(dk);
          }}
          btnBaseClassName={props.btnBaseClassName}
        />
      ) : (
        <section className="mb-3 rounded-[10px] border border-[#2a3140] bg-[#161a22] p-2.5">
          <h2 className="mb-2 text-xs font-medium text-[#9aa3b2]">
            Import dates (CSV)
          </h2>
          <div
            role="button"
            tabIndex={0}
            className={[
              "group relative rounded-xl border-2 border-dashed px-3 py-6 text-center transition-colors outline-none",
              "focus-visible:ring-2 focus-visible:ring-[#4c8bf5]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0f1115]",
              csvDragOver
                ? "border-[#4c8bf5] bg-[#4c8bf5]/10"
                : "border-[#3a4354] bg-[#12151c] hover:border-[#4c8bf5]/50 hover:bg-[#161a22]",
            ].join(" ")}
            onDragEnter={(e) => {
              e.preventDefault();
              csvDragDepth.current += 1;
              setCsvDragOver(true);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }}
            onDragLeave={(e) => {
              e.preventDefault();
              csvDragDepth.current = Math.max(0, csvDragDepth.current - 1);
              if (csvDragDepth.current === 0) setCsvDragOver(false);
            }}
            onDrop={onCsvDropZoneDrop}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                csvInputRef.current?.click();
              }
            }}
            onClick={() => csvInputRef.current?.click()}
          >
            <input
              ref={csvInputRef}
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              aria-label="Choose CSV file"
              onChange={onCsvInputChange}
            />
            <div className="pointer-events-none mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-full border border-[#2a3140] bg-[#1e2430] text-[#9aa3b2] group-hover:text-[#e8eaef]">
              <Upload className="h-5 w-5" strokeWidth={1.75} aria-hidden />
            </div>
            <p className="m-0 text-[13px] font-medium text-[#e8eaef]">
              Drop a CSV here or <span className="text-[#4c8bf5]">browse</span>
            </p>
          </div>

          {csvHint ? (
            <p
              className={`mt-2 mb-0 text-[11px] ${
                csvHint.startsWith("Imported")
                  ? "text-[#8bd49a]"
                  : "text-[#f0a96e]"
              }`}
            >
              {csvHint}
            </p>
          ) : null}

          {props.importedDateOrder.length > 0 ? (
            <div className="mt-3">
              <h3 className="mb-1.5 text-xs font-medium text-[#9aa3b2]">
                Dates in file ({props.importedDateOrder.length})
              </h3>
              <ul className="m-0 max-h-[min(200px,32vh)] list-none space-y-1 overflow-y-auto rounded-md border border-[#2a3140]/70 bg-[#12151c]/60 p-2 font-mono text-[11px] text-[#b8c0cc]">
                {props.importedDateOrder.map((dk) => (
                  <li key={dk}>
                    <button
                      type="button"
                      className={[
                        "w-full rounded px-1.5 py-0.5 text-left transition-colors",
                        dk === props.selectedDateKey
                          ? "bg-[#4c8bf5]/20 text-[#e8eaef]"
                          : "text-[#b8c0cc] hover:bg-[#2a3140]/80 hover:text-[#e8eaef]",
                      ].join(" ")}
                      onClick={() => props.onSelectedDateKeyChange(dk)}
                    >
                      {dk}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 mb-0 text-[10px] text-[#5c6570]">
                Highlight matches &quot;Actions for&quot; selection. Scrape uses
                all listed dates in order.
              </p>
            </div>
          ) : null}
        </section>
      )}
    </>
  );
}

