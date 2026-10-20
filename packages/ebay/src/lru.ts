export type Lru<K, V> = {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  delete(key: K): void;
  readonly size: number;
};

// A Map keeps insertion order, so moving a key to the end on every use leaves the least recently
// used key first.
export function createLru<K, V>(capacity: number): Lru<K, V> {
  const entries = new Map<K, V>();
  return {
    get(key) {
      const value = entries.get(key);
      if (value === undefined) return undefined;
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      if (entries.size > capacity) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
    },
    delete(key) {
      entries.delete(key);
    },
    get size() {
      return entries.size;
    },
  };
}
