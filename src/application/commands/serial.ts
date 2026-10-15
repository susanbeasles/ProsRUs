/** Per-Coordinator mutation tail. Durable Object input gates do not hold across
 * awaited D1/R2/RPC I/O, so every command for one owner/workspace runs strictly
 * after the previous one settles. Reads never enter this tail. */
export function createSerialQueue() {
  let tail: Promise<void> = Promise.resolve();
  return {
    run<T>(work: () => Promise<T>): Promise<T> {
      const next = tail.then(work, work);
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}
