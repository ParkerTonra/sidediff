import type { BuiltIndex } from './build';

export interface IndexRequest {
  id: number;
  a: string;
  b: string;
}

export type IndexResponse = { id: number; ok: true; index: BuiltIndex; workerMs: number } | { id: number; ok: false; message: string };
