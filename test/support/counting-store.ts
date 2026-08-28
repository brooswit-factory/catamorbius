import type { Store } from "../../src/store/index.js";

export interface CountingStore extends Store {
  subscriberCount(): number;
}

/** Wraps a Store to expose a live subscriber count, so a test can prove a disconnect actually unsubscribed. */
export function withSubscriberCount(store: Store): CountingStore {
  let count = 0;
  return {
    ...store,
    subscribe(fn) {
      count++;
      const unsubscribe = store.subscribe(fn);
      return () => {
        count--;
        unsubscribe();
      };
    },
    subscriberCount() {
      return count;
    },
  };
}
