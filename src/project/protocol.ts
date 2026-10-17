import type { SearchHit, SearchOptions, Side } from '../types';
import type { ZipRecord } from '../package/zip';
import type { BuiltIndex, PackageFile } from './build';

/**
 * A side's package as sent to the worker: the zip Blob and directory (read
 * there, lazily), or, for sources not made by createPackageReader, the files'
 * bytes read up front.
 */
export type WorkerPackage = { kind: 'zip'; blob: Blob; records: ZipRecord[]; files: PackageFile[] } | { kind: 'bytes'; files: PackageFile[]; data: Record<string, Uint8Array> };

export type IndexRequest =
  | { type: 'index'; id: number; a: string; b: string; packages: Partial<Record<Side, WorkerPackage>> }
  | { type: 'search'; id: number; query: string; options: SearchOptions };

export type IndexResponse =
  | { type: 'index'; id: number; ok: true; index: BuiltIndex; workerMs: number }
  | { type: 'search'; id: number; ok: true; hits: SearchHit[]; workerMs: number }
  | { type: 'index' | 'search'; id: number; ok: false; message: string };
