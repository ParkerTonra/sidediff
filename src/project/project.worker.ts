// Project indexer worker: scans both texts, reads package directories, matches
// items, and keeps the result for search. A superseded index run is stopped by
// terminating this worker (like D11). Messages are handled in order.
import type { IndexRequest } from './protocol';
import { createWorkerCore } from './worker-core';

const core = createWorkerCore();

self.onmessage = (ev: MessageEvent<IndexRequest>) => {
  void core(ev.data).then((res) => self.postMessage(res));
};
