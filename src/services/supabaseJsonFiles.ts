import type { ExtensionMessage } from "@shared/messages";

export const SUPABASE_JSON_PUBLIC_BASE =
  "https://gfxknuxbtkhomfodrrfr.supabase.co/storage/v1/object/public/json-files/";

export type SupabaseJsonFile = {
  id: string;
  file_date: string;
  file_path: string;
  created_at: string;
  group_id: string;
  rows_count: number | string;
  signed_url?: string;
};

/** Fetches JSON file metadata for a calendar date from Supabase via the extension background. */
export async function fetchSupabaseJsonFilesByDate(
  date: string,
): Promise<SupabaseJsonFile[]> {
  const res = (await chrome.runtime.sendMessage({
    type: "supabase/getJsonByDate",
    date,
  } satisfies ExtensionMessage)) as
    | { ok: true; files: SupabaseJsonFile[] }
    | { ok: false; error: string };
  if (!res || typeof res !== "object" || res.ok !== true) {
    throw new Error(
      res && typeof res === "object" && "error" in res
        ? String((res as { error: unknown }).error)
        : "getJsonByDate failed",
    );
  }
  return Array.isArray(res.files) ? res.files : [];
}
