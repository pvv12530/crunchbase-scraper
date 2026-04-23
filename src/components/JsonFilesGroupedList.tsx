import { Download, FolderDown, RotateCw, Trash2 } from "lucide-react";
import type { SupabaseJsonFile } from "../services/supabaseJsonFiles";

type JsonFilesGroupedListProps = {
  /** Supabase `file_date` bucket(s), shown in the heading. */
  bucketsLabel: string;
  files: SupabaseJsonFile[];
  loading: boolean;
  error: string;
  downloadingById: Record<string, boolean>;
  deletingById: Record<string, boolean>;
  downloadingGroupById: Record<string, boolean>;
  onReload: () => void;
  onDownload: (f: SupabaseJsonFile) => void;
  onDelete: (id: string) => void;
  onDownloadGroup: (groupId: string, files: SupabaseJsonFile[]) => void;
};

function groupLabel(groupId: string | null | undefined): string {
  const g = (groupId ?? "").trim();
  return g.length > 0 ? g : "(no group)";
}

export function JsonFilesGroupedList({
  bucketsLabel,
  files,
  loading,
  error,
  downloadingById,
  deletingById,
  downloadingGroupById,
  onReload,
  onDownload,
  onDelete,
  onDownloadGroup,
}: JsonFilesGroupedListProps): JSX.Element {
  const groups = new Map<string, SupabaseJsonFile[]>();
  for (const f of files) {
    const k = groupLabel(f.group_id);
    const cur = groups.get(k);
    if (cur) cur.push(f);
    else groups.set(k, [f]);
  }

  const groupEntries = Array.from(groups.entries()).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );

  return (
    <>
      <div className="mb-1.5 mt-1 flex items-center justify-between gap-2">
        <h3 className="m-0 text-xs font-medium text-[#9aa3b2]">
          JSON in cloud (file_date: {bucketsLabel || "—"})
        </h3>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md border border-[#2a3140] bg-[#1e2430] px-2.5 py-1.5 text-[11px] font-medium text-[#e8eaef] cursor-pointer transition-opacity disabled:opacity-[0.45] disabled:cursor-not-allowed"
          onClick={() => void onReload()}
          disabled={loading}
          title="Reload JSON list"
          aria-label="Reload JSON list"
        >
          <RotateCw
            className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
            aria-hidden
          />
          Reload
        </button>
      </div>
      <p className="mb-2 m-0 text-[11px] text-[#9aa3b2]">
        {loading
          ? "Loading…"
          : error
            ? `Error: ${error}`
            : files.length === 0
              ? "No files for these date key(s)."
              : `${files.length} file${files.length === 1 ? "" : "s"} found in ${groupEntries.length} group${groupEntries.length === 1 ? "" : "s"}.`}
      </p>

      {!loading && !error ? (
        files.length === 0 ? (
          <div className="mb-3 rounded-lg border border-dashed border-[#2a3140] bg-[#12151c]/80 px-3 py-6 text-center text-[12px] text-[#9aa3b2]">
            No uploaded JSON files for {bucketsLabel || "these keys"}.
          </div>
        ) : (
          <div className="mb-3 max-h-[min(320px,48vh)] overflow-y-auto pr-0.5">
            <ul className="m-0 list-none space-y-2 p-0">
              {groupEntries.map(([gid, groupFiles]) => {
                const busy =
                  downloadingGroupById[gid] === true ||
                  groupFiles.some((f) => downloadingById[f.id] === true) ||
                  groupFiles.some((f) => deletingById[f.id] === true);
                const downloadingGroup = downloadingGroupById[gid] === true;
                return (
                  <li
                    key={gid}
                    className="rounded-lg border border-[#2a3140] bg-[#12151c]"
                  >
                    <div className="flex items-center justify-between gap-2 px-2.5 py-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-xs font-medium text-[#e8eaef]">
                          <span className="shrink-0 text-[#9aa3b2]">Group</span>
                          <span className="min-w-0 truncate font-mono">
                            {gid}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-[#9aa3b2]">
                          {groupFiles.length} file
                          {groupFiles.length === 1 ? "" : "s"}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="flex items-center gap-1.5 rounded-md border border-[#2a3140] bg-[#1e2430] px-2.5 py-1.5 text-[11px] font-medium text-[#e8eaef] cursor-pointer transition-opacity disabled:opacity-[0.45] disabled:cursor-not-allowed"
                        onClick={() => void onDownloadGroup(gid, groupFiles)}
                        disabled={busy}
                        title="Download zip for this group"
                        aria-label={`Download group ${gid}`}
                      >
                        <FolderDown className="h-4 w-4" aria-hidden />
                      </button>
                    </div>

                    <ul className="m-0 list-none space-y-1.5 border-t border-[#2a3140] p-2.5">
                      {groupFiles
                        .slice()
                        .sort((a, b) => a.file_path.localeCompare(b.file_path))
                        .map((f) => {
                          const downloading = downloadingById[f.id] === true;
                          const deleting = deletingById[f.id] === true;
                          return (
                            <li
                              key={f.id}
                              className="flex items-center justify-between gap-2 rounded-md border border-[#2a3140] bg-[#0f1115]/30 px-2.5 py-2 text-xs"
                            >
                              <span className="min-w-0 truncate text-[#e8eaef]">
                                {f.file_path.split("/").pop() ?? f.file_path}
                              </span>
                              <div className="flex shrink-0 items-center gap-1.5">
                                <button
                                  type="button"
                                  className="text-xs text-[#e8eaef] cursor-pointer transition-opacity disabled:opacity-[0.45] disabled:cursor-not-allowed"
                                  onClick={() => void onDownload(f)}
                                  disabled={
                                    deleting || downloading || downloadingGroup
                                  }
                                  title={`Download\n${f.file_path}`}
                                  aria-label={`Download ${f.file_path}`}
                                >
                                  <Download className="h-4 w-4" aria-hidden />
                                </button>
                                <button
                                  type="button"
                                  className="text-xs text-[#e8eaef] cursor-pointer transition-opacity disabled:opacity-[0.45] disabled:cursor-not-allowed"
                                  onClick={() => void onDelete(f.id)}
                                  disabled={
                                    deleting || downloading || downloadingGroup
                                  }
                                  title="Delete"
                                  aria-label={`Delete ${f.file_path}`}
                                >
                                  <Trash2 className="h-4 w-4" aria-hidden />
                                </button>
                              </div>
                            </li>
                          );
                        })}
                    </ul>
                  </li>
                );
              })}
            </ul>
          </div>
        )
      ) : null}
    </>
  );
}
