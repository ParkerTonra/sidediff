// Project indexer worker: scans both texts and matches items off the main
// thread. A superseded run is stopped by terminating this worker (like D11).
import { buildIndex } from './build';
import type { IndexRequest, IndexResponse } from './protocol';

self.onmessage = async (ev: MessageEvent<IndexRequest>) => {
  const { id, a, b } = ev.data;
  let msg: IndexResponse;
  try {
    const t0 = performance.now();
    const index = await buildIndex(a, b);
    msg = { id, ok: true, index, workerMs: performance.now() - t0 };
  } catch (err) {
    msg = { id, ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(msg);
};
