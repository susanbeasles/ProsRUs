import { canonicalJson } from "../../integration/shared-contract.mjs";

const REQUEST_KEY = /^[A-Za-z0-9_-]{1,100}$/;

/** One request key per user intent. crypto.randomUUID() output satisfies the catalog pattern. */
export function createRequestKey(random: () => string = () => crypto.randomUUID()): string {
  const key = random();
  if (!REQUEST_KEY.test(key)) throw Error("Invalid request key");
  return key;
}

export type IntentDecision = { readonly kind: "retry"; readonly mutationId: string } | { readonly kind: "start" };

/**
 * Remembers the last attempt of one user intent (one form). Resubmitting identical values after a
 * retryable failure is the same intent and reuses the earlier mutation (and its request key);
 * changed values are a new intent with a new key, because a key may never carry a changed meaning.
 */
export class IntentTracker {
  #last: { canonical: string; mutationId: string } | null = null;

  decide(values: unknown, retryable: (mutationId: string) => boolean): IntentDecision {
    const last = this.#last;
    if (last && last.canonical === canonicalJson(values) && retryable(last.mutationId))
      return { kind: "retry", mutationId: last.mutationId };
    return { kind: "start" };
  }

  remember(values: unknown, mutationId: string): void {
    this.#last = { canonical: canonicalJson(values), mutationId };
  }

  reset(): void {
    this.#last = null;
  }
}
