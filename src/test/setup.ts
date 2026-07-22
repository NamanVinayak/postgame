import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';

// Node 25 exposes an experimental (and here, non-functional) global
// `localStorage` that shadows jsdom's. Install a dependable in-memory one.
const store = new Map<string, string>();
const memoryLocalStorage: Storage = {
  getItem: (key) => (store.has(key) ? store.get(key)! : null),
  setItem: (key, value) => {
    store.set(key, String(value));
  },
  removeItem: (key) => {
    store.delete(key);
  },
  clear: () => {
    store.clear();
  },
  key: (index) => Array.from(store.keys())[index] ?? null,
  get length() {
    return store.size;
  },
};

Object.defineProperty(globalThis, 'localStorage', {
  value: memoryLocalStorage,
  writable: true,
  configurable: true,
});
