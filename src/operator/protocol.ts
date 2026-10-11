import { createHash } from "node:crypto";
export const OPERATOR_LIMITS = Object.freeze({
  sources: 5,
  roles: 154,
  original: 512 * 1024,
  sourceTotal: 5 * 512 * 1024,
  profile: 5000,
  plan: 8 * 1024 * 1024,
  chunks: 4,
  request: 4 * 1024 * 1024,
  response: 2 * 1024 * 1024,
  fragment: 48 * 1024,
  fragments: 256,
  emptyFragments: 32,
  stallMs: 30000,
  aggregate: 16 * 1024 * 1024,
  code: 6 * 1024 * 1024,
  toolArgs: 8 * 1024 * 1024,
  batch: 4 * 1024 * 1024,
  requests: 34,
  r2: 25,
  d1: 9,
  sql: 24,
  frames: 128,
});
// Dormant contract only. No live probe is implemented or authorized by these constants.
export const QUALIFICATION_LIMITS = Object.freeze({
  managementRequests: 8,
  d1Requests: 5,
  sql: 8,
  r2Requests: 3,
  fixtureBytes: 1024,
});
export const PROTOCOL = "job-stack.operator-broker.v1";
export const utf8 = (value: string) => Buffer.byteLength(value, "utf8");
export const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export function demandOperator(
  value: unknown,
  code = "operator-denied",
): asserts value {
  if (!value) throw Error(code);
}
export function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          stable((value as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}
function parseCanonical(text: string): unknown {
  const value: unknown = JSON.parse(text);
  demandOperator(
    stable(value) === text,
    "operator-noncanonical-or-duplicate-frame",
  );
  return value;
}
export type Effect = {
  kind:
    | "current"
    | "r2.get"
    | "r2.put"
    | "d1.first"
    | "d1.all"
    | "d1.batch"
    | "done";
  payload: unknown;
};
export type RequestFrame = Effect & {
  protocol: typeof PROTOCOL;
  sequence: number;
  actionDigest: string;
  requestDigest: string;
};
export type ResponseFrame = {
  protocol: typeof PROTOCOL;
  sequence: number;
  actionDigest: string;
  requestDigest: string;
  ok: boolean;
  result: unknown;
};
export function requestFrame(
  effect: Effect,
  sequence: number,
  actionDigest: string,
): RequestFrame {
  const request = {
    protocol: PROTOCOL as typeof PROTOCOL,
    sequence,
    actionDigest,
    ...effect,
  };
  return { ...request, requestDigest: sha256(stable(request)) };
}
export function parseRequest(text: string): RequestFrame {
  demandOperator(
    utf8(text) <= OPERATOR_LIMITS.request,
    "operator-request-bound",
  );
  const v = parseCanonical(text) as RequestFrame;
  demandOperator(
    v &&
      Object.keys(v).sort().join(",") ===
        "actionDigest,kind,payload,protocol,requestDigest,sequence" &&
      v.protocol === PROTOCOL &&
      Number.isSafeInteger(v.sequence) &&
      v.sequence > 0 &&
      v.sequence <= OPERATOR_LIMITS.frames &&
      /^[a-f0-9]{64}$/.test(v.actionDigest) &&
      /^[a-f0-9]{64}$/.test(v.requestDigest),
  );
  const { requestDigest, ...data } = v;
  demandOperator(sha256(stable(data)) === requestDigest, "operator-digest");
  return v;
}
export function checkedResponse(
  text: string,
  request: RequestFrame,
): ResponseFrame {
  demandOperator(
    utf8(text) <= OPERATOR_LIMITS.response,
    "operator-response-bound",
  );
  const v = parseCanonical(text) as ResponseFrame;
  demandOperator(
    v &&
      Object.keys(v).sort().join(",") ===
        "actionDigest,ok,protocol,requestDigest,result,sequence" &&
      v.protocol === PROTOCOL &&
      v.sequence === request.sequence &&
      v.actionDigest === request.actionDigest &&
      v.requestDigest === request.requestDigest &&
      typeof v.ok === "boolean",
    "operator-response-binding",
  );
  return v;
}
/** Each caller owns one unfinished frame; overflow/stall errors stay sticky. No physical-memory claim. */
export function createFrameReader({
  deadline,
  now = () => Date.now(),
  reserve,
}: {
  deadline: number;
  now?: () => number;
  reserve: (bytes: number) => void;
}) {
  let parts: Uint8Array[] = [],
    bytes = 0,
    nonempty = 0,
    empty = 0,
    last = now(),
    failed = false;
  const check = () => {
    demandOperator(
      !failed && now() < deadline && now() - last < OPERATOR_LIMITS.stallMs,
      "operator-frame-stalled",
    );
  };
  function fail(error: unknown): never {
    failed = true;
    throw error;
  }
  return Object.freeze({
    push(fragment: Uint8Array) {
      try {
        check();
        demandOperator(
          fragment instanceof Uint8Array &&
            fragment.length <= OPERATOR_LIMITS.fragment,
          "operator-fragment-bound",
        );
        if (fragment.length) {
          demandOperator(
            ++nonempty <= OPERATOR_LIMITS.fragments,
            "operator-fragment-count",
          );
          reserve(bytes + fragment.length);
          bytes += fragment.length;
          demandOperator(
            bytes <= OPERATOR_LIMITS.request,
            "operator-frame-bound",
          );
          parts.push(fragment.slice());
          last = now();
        } else
          demandOperator(
            ++empty <= OPERATOR_LIMITS.emptyFragments,
            "operator-empty-fragments",
          );
      } catch (e) {
        fail(e);
      }
    },
    finish() {
      try {
        check();
        const result = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(Buffer.concat(parts));
        demandOperator(!result.startsWith("\uFEFF"), "operator-frame-bom");
        parts = [];
        bytes = 0;
        nonempty = 0;
        empty = 0;
        reserve(0);
        return result;
      } catch (e) {
        fail(e);
      }
    },
    check() {
      try {
        check();
      } catch (e) {
        fail(e);
      }
    },
  });
}
