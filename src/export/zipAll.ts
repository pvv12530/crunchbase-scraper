import { zipSync, strToU8 } from 'fflate';

export function zipJsonFiles(files: { path: string; json: unknown }[]): Blob {
  const out: Record<string, Uint8Array> = {};
  for (const f of files) {
    const text = JSON.stringify(f.json, null, 2);
    out[f.path] = strToU8(text);
  }
  const zipped = zipSync(out);
  return new Blob([new Uint8Array(zipped)], { type: 'application/zip' });
}
