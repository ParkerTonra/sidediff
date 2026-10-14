// Owned by Languages. Phase 0 stub: replace with the real registry.
import type { LanguageRegistry } from '../types';

export interface RegistryOptions {
  manifestUrl?: string;
  fetchFn?: typeof fetch;
  indexedDB?: IDBFactory;
}

export function createLanguageRegistry(_options: RegistryOptions = {}): LanguageRegistry {
  throw new Error('createLanguageRegistry: not implemented yet');
}
