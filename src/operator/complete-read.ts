import { demandOperator as demand, stable, utf8 } from "./protocol";

export type CompleteReadBinding = {
  accountId: string;
  bucket: string;
  key: string;
  sourceName: string;
  actionDigest: string;
  sequence: number;
  requestDigest: string;
};
export type CompleteReadReceipt = CompleteReadBinding & {
  format: "job-stack.remote-original-read.v1";
  status: 200;
  complete: true;
  sizeBytes: number;
  sha256: string;
  literalBytesEqual: true;
};
type ReadInput = {
  binding: CompleteReadBinding;
  expectedBase64: string;
  expectedSha256: string;
  expectedSize: number;
  expiresAtMs: number;
};
/** This function is emitted verbatim into the trusted proxy. It has no free variables.
 * Only the source-owned assembler supplies input, never the child or provider. */
async function remoteRead(input: ReadInput) {
  const { binding } = input;
  if (
    !Number.isSafeInteger(input.expectedSize) ||
    input.expectedSize < 1 ||
    input.expectedSize > 524288 ||
    input.expectedBase64.length > 699052 ||
    !Number.isSafeInteger(input.expiresAtMs)
  )
    throw Error("operator-read-bound");
  const controller = new AbortController();
  const deadline = Math.min(Date.now() + 30000, input.expiresAtMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        controller.abort();
        reject(Error("operator-read-deadline"));
      },
      Math.max(0, deadline - Date.now()),
    );
  });
  const check = () => {
    if (controller.signal.aborted || Date.now() >= deadline)
      throw Error("operator-read-deadline");
  };
  async function bounded<T>(work: Promise<T>): Promise<T> {
    check();
    const result = await Promise.race([work, cancelled]);
    check();
    return result;
  }
  try {
    check();
    const response = await bounded(
      fetch(
        `https://api.cloudflare.com/client/v4/accounts/${binding.accountId}/r2/buckets/${binding.bucket}/objects/${binding.key.split("/").map(encodeURIComponent).join("/")}`,
        { method: "GET", redirect: "manual", signal: controller.signal },
      ),
    );
    if (response.status !== 200 && response.status !== 404)
      throw Error("operator-read-status");
    if (response.redirected || !response.body)
      throw Error("operator-read-response");
    const encoding = response.headers.get("content-encoding");
    if (encoding !== null && encoding !== "identity")
      throw Error("operator-read-encoding");
    const limit = response.status === 200 ? input.expectedSize : 8192;
    const declared = response.headers.get("content-length");
    if (
      declared !== null &&
      (!/^(0|[1-9][0-9]*)$/.test(declared) ||
        !Number.isSafeInteger(Number(declared)) ||
        Number(declared) > limit)
    )
      throw Error("operator-read-length");
    const body = new Uint8Array(limit);
    let size = 0,
      chunks = 0,
      empty = 0;
    reader = response.body.getReader();
    while (true) {
      const next = await bounded(reader.read());
      if (next.done) break;
      if (
        !(next.value instanceof Uint8Array) ||
        ++chunks > 1024 ||
        (next.value.length === 0 && ++empty > 32) ||
        next.value.length > limit - size
      )
        throw Error("operator-read-bound");
      body.set(next.value, size);
      size += next.value.length;
    }
    if (declared !== null && Number(declared) !== size)
      throw Error("operator-read-length");
    if (response.status === 404) {
      const text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(body.subarray(0, size));
      const value: unknown = JSON.parse(text);
      const shape = (
        v: unknown,
        fields: string,
      ): v is Record<string, unknown> =>
        !!v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        Object.keys(v).sort().join(",") === fields;
      if (
        !shape(value, "errors,messages,result,success") ||
        value.success !== false ||
        value.result !== null ||
        !Array.isArray(value.messages) ||
        value.messages.length !== 0 ||
        !Array.isArray(value.errors) ||
        value.errors.length === 0 ||
        value.errors.some(
          (error) =>
            !shape(error, "code,message") ||
            error.code !== 10007 ||
            typeof error.message !== "string" ||
            error.message.length === 0,
        )
      )
        throw Error("operator-read-absence");
      // JSON.parse erases duplicate keys. Count actual key tokens, skipping entire
      // escaped message strings, against this closed two-level error schema.
      const keys = new Map<string, number>();
      for (const token of text.matchAll(/"(?:[^"\\]|\\.)*"/gs)) {
        if (token.index === undefined) throw Error("operator-read-absence");
        if (
          !text.slice(token.index + token[0].length).trimStart().startsWith(":")
        )
          continue;
        const key: string = JSON.parse(token[0]);
        keys.set(key, (keys.get(key) ?? 0) + 1);
      }
      const errorCount = value.errors.length;
      if (
        keys.size !== 6 ||
        ["success", "result", "errors", "messages"].some(
          (key) => keys.get(key) !== 1,
        ) ||
        ["code", "message"].some((key) => keys.get(key) !== errorCount)
      )
        throw Error("operator-read-absence");
      check();
      return {
        ...binding,
        format: "job-stack.remote-original-absent.v1",
        status: 404,
        complete: true,
        errorCode: 10007,
      };
    }
    if (size !== input.expectedSize || size === 0)
      throw Error("operator-original-conflict");
    const sha256 = Array.from(
      new Uint8Array(await bounded(crypto.subtle.digest("SHA-256", body))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const expected = Uint8Array.from(atob(input.expectedBase64), (c) =>
      c.charCodeAt(0),
    );
    if (
      expected.length !== size ||
      sha256 !== input.expectedSha256 ||
      body.some((byte, index) => byte !== expected[index])
    )
      throw Error("operator-original-conflict");
    check();
    const result = {
      ...binding,
      format: "job-stack.remote-original-read.v1",
      status: 200,
      complete: true,
      sizeBytes: size,
      sha256,
      literalBytesEqual: true,
    };
    if (new TextEncoder().encode(JSON.stringify(result)).length > 2048)
      throw Error("operator-read-receipt-bound");
    return result;
  } finally {
    clearTimeout(timer);
    controller.abort();
    // Cancellation itself can stall. Request it, handle rejection, never await it.
    if (reader) {
      void reader.cancel().catch(() => {});
      try {
        reader.releaseLock();
      } catch {
        /* Pending read remains rejected/observed. */
      }
    }
  }
}
export function completeReadCode(input: ReadInput): string {
  demand(
    Number.isSafeInteger(input.expectedSize) &&
      input.expectedSize > 0 &&
      input.expectedSize <= 524288 &&
      input.expectedBase64.length <= 699052,
    "operator-read-bound",
  );
  // Reserve the complete output before any effect, including long admitted key/name fields.
  demand(
    utf8(
      stable({
        ...input.binding,
        format: "job-stack.remote-original-read.v1",
        status: 200,
        complete: true,
        sizeBytes: input.expectedSize,
        sha256: input.expectedSha256,
        literalBytesEqual: true,
      }),
    ) <= 2048,
    "operator-read-receipt-bound",
  );
  return `async () => (${remoteRead.toString()})(${stable(input)})`;
}
/** Closed evidence is useful only paired with the exact dispatched parent frame. */
export function validateCompleteRead(
  value: unknown,
  binding: CompleteReadBinding,
  source: { sizeBytes: number; sha256: string },
  allowAbsent = false,
): CompleteReadReceipt | null {
  demand(
    value && typeof value === "object" && !Array.isArray(value),
    "operator-original-shape",
  );
  const result = value as Record<string, unknown>;
  demand(utf8(stable(result)) <= 2048, "operator-read-receipt-bound");
  demand(
    Object.entries(binding).every(
      ([key, expected]) => result[key] === expected,
    ),
    "operator-read-binding",
  );
  const keys = Object.keys(result).sort().join(",");
  if (result.format === "job-stack.remote-original-absent.v1") {
    demand(
      allowAbsent &&
        keys ===
          "accountId,actionDigest,bucket,complete,errorCode,format,key,requestDigest,sequence,sourceName,status" &&
        result.status === 404 &&
        result.complete === true &&
        result.errorCode === 10007,
      "operator-original-absent",
    );
    return null;
  }
  demand(
    keys ===
      "accountId,actionDigest,bucket,complete,format,key,literalBytesEqual,requestDigest,sequence,sha256,sizeBytes,sourceName,status" &&
      result.format === "job-stack.remote-original-read.v1" &&
      result.status === 200 &&
      result.complete === true &&
      result.literalBytesEqual === true &&
      Number.isSafeInteger(result.sizeBytes) &&
      Number(result.sizeBytes) > 0 &&
      result.sizeBytes === source.sizeBytes &&
      typeof result.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(result.sha256) &&
      result.sha256 === source.sha256,
    "operator-original-conflict",
  );
  return result as CompleteReadReceipt;
}
