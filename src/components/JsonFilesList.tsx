import { Download, Trash2 } from "lucide-react";
import type { SupabaseJsonFile } from "../services/supabaseJsonFiles";

type JsonFilesListProps = {
  /** Supabase `file_date` bucket(s), shown in the heading. */
  bucketsLabel: string;
  files: SupabaseJsonFile[];
  loading: boolean;
  error: string;
  downloadingById: Record<string, boolean>;
  deletingById: Record<string, boolean>;
  onDownload: (f: SupabaseJsonFile) => void;
  onDelete: (id: string) => void;
};

export function JsonFilesList({
  bucketsLabel,
  files,
  loading,
  error,
  downloadingById,
  deletingById,
  onDownload,
  onDelete,
}: JsonFilesListProps): JSX.Element {
  return (
    <>
      <h3 className="mb-1.5 mt-1 text-xs font-medium text-[#9aa3b2]">
        JSON in cloud (file_date: {bucketsLabel || "—"})
      </h3>
      <p className="mb-2 m-0 text-[11px] text-[#9aa3b2]">
        {loading
          ? "Loading…"
          : error
            ? `Error: ${error}`
            : files.length === 0
              ? "No files for these date key(s)."
              : `${files.length} file${files.length === 1 ? "" : "s"} found.`}
      </p>
      {!loading && !error ? (
        files.length === 0 ? (
          <div className="mb-3 rounded-lg border border-dashed border-[#2a3140] bg-[#12151c]/80 px-3 py-6 text-center text-[12px] text-[#9aa3b2]">
            No uploaded JSON files for {bucketsLabel || "these keys"}.
          </div>
        ) : (
          <ul className="m-0 mb-3 max-h-[min(220px,40vh)] list-none space-y-1.5 overflow-y-auto p-0 pr-0.5">
            {files.map((f) => {
              const downloading = downloadingById[f.id] === true;
              const deleting = deletingById[f.id] === true;
              return (
                <li
                  key={f.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-[#2a3140] bg-[#12151c] px-2.5 py-2 text-xs"
                >
                  <span className="min-w-0 truncate text-[#e8eaef]">
                    {f.file_path.split("/").pop() ?? f.file_path}
                  </span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      className="text-xs text-[#e8eaef] cursor-pointer transition-opacity disabled:opacity-[0.45] disabled:cursor-not-allowed"
                      onClick={() => void onDownload(f)}
                      disabled={deleting || downloading}
                      title={`Download\n${f.file_path}`}
                      aria-label={`Download ${f.file_path}`}
                    >
                      <Download className="h-4 w-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="text-xs text-[#e8eaef] cursor-pointer transition-opacity disabled:opacity-[0.45] disabled:cursor-not-allowed"
                      onClick={() => void onDelete(f.id)}
                      disabled={deleting || downloading}
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
        )
      ) : null}
    </>
  );
}
