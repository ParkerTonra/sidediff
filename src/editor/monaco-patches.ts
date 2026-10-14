// Targeted fixes for Monaco 0.57 internals, measured on the 150k fixture.
// Re-check on every Monaco upgrade; see DECISIONS.md (Editor decisions).
import { ViewOverlayWidgets } from 'monaco-editor/editor/browser/viewParts/overlayWidgets/overlayWidgets';

/**
 * ViewOverlayWidgets._updateMaxMinWidth rescans every overlay widget on each
 * add/remove, so creating N "hidden lines" separators costs O(N²). With ~1,700
 * hunks (diff only on, large fixture) that was ~190 ms of a 330 ms main-thread
 * task. Coalescing it to once per microtask keeps the result identical (it is
 * still computed before the next render) and makes it O(N).
 */
function coalesceOverlayMinWidth(): void {
  const proto = ViewOverlayWidgets.prototype;
  const original = proto._updateMaxMinWidth;
  if (typeof original !== 'function') {
    console.warn('sidediff: Monaco internals changed; overlay min-width patch skipped');
    return;
  }
  const pending = new WeakSet<object>();
  proto._updateMaxMinWidth = function (this: ViewOverlayWidgets): void {
    if (pending.has(this)) return;
    pending.add(this);
    queueMicrotask(() => {
      pending.delete(this);
      try {
        original.call(this);
      } catch {
        // The view was disposed in the meantime; nothing to update.
      }
    });
  };
}

export function applyMonacoPatches(): void {
  coalesceOverlayMinWidth();
}
