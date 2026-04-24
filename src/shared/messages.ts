import type { SourceId } from './constants';
import type { ChunkRecord, DateRunMeta, TabContextPayload } from './models';

/** Runtime message types (background ↔ side panel ↔ content) */
export type ExtensionMessage =
  | { type: 'tabContext/get' }
  | { type: 'tabContext/changed'; payload: TabContextPayload }
  | { type: 'runs/list' }
  | { type: 'runs/listResponse'; runs: DateRunMeta[] }
  | { type: 'supabase/getJsonByDate'; date: string }
  | {
      type: 'supabase/uploadJson';
      date: string;
      filename: string;
      jsonText: string;
      group_id?: string;
      rows_count?: string | number;
    }
  | {
      type: 'scrape/start';
      dateKey: string;
      dateKeys?: string[];
      groupId?: string;
      sourceId: SourceId;
    }
  | { type: 'scrape/resultsStart'; runKey: string }
  | { type: 'scrape/stop' }
  | { type: 'scrape/queueClear' }
  | { type: 'scrape/queueRemove'; dateKey: string }
  | { type: 'scrape/queueGet' }
  | { type: 'scrape/retryDate'; dateKey: string; sourceId: SourceId }
  | { type: 'scrape/queueChanged' }
  | { type: 'scrape/abort' }
  | { type: 'scrape/progress'; dateKey: string; pageIndex: number; chunkId: string; rowCount?: number }
  | { type: 'scrape/log'; dateKey: string; level: 'info' | 'warn' | 'error'; text: string; at: string }
  | { type: 'scrape/complete'; dateKey: string; meta: DateRunMeta }
  /** Background finished merged JSON download + optional Supabase upload after a date scrape. */
  /** `dateKeys` are Supabase `file_date` buckets to refresh (usually one scrape date per file). */
  | { type: 'scrape/jsonArtifactsUpdated'; dateKeys: string[] }
  | { type: 'scrape/error'; dateKey: string; message: string; partial: boolean }
  | { type: 'content/chunk'; tabId: number; record: ChunkRecord }
  | { type: 'content/done'; tabId: number; dateKey: string; totalRows: number }
  | { type: 'content/log'; tabId: number; dateKey: string; level: 'info' | 'warn' | 'error'; text: string }
  | { type: 'content/error'; tabId: number; dateKey: string; message: string; partial: boolean; cancelled?: boolean }
  | { type: 'import/csv'; text: string }
  | { type: 'import/csvResponse'; dates: string[]; error?: string }
  | { type: 'download/chunk'; dateKey: string; chunkId: string }
  | { type: 'download/dateZip'; dateKey: string }
  | { type: 'download/allZip' };

export function isMessage(x: unknown): x is ExtensionMessage {
  return typeof x === 'object' && x !== null && 'type' in x;
}
