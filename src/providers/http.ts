export type Http = typeof fetch;
export class ProviderFailure extends Error {
  constructor(
    public readonly code: string,
    public readonly ambiguous = false,
    public readonly retryable = false,
  ) {
    super(code);
  }
}
export async function boundedText(response: Response, limit = 1024 * 1024) {
  if (Number(response.headers.get("content-length")) > limit)
    throw new ProviderFailure("RESPONSE_TOO_LARGE");
  const reader = response.body?.getReader();
  if (!reader) return "";
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new ProviderFailure("RESPONSE_TOO_LARGE");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(all);
}
export async function boundedJson(
  http: Http,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const mutating = init.method === "POST" || init.method === "PATCH";
  let response: Response;
  try {
    response = await http(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ProviderFailure("PROVIDER_UNREACHABLE", mutating, true);
  }
  if (response.status >= 300 && response.status < 400)
    throw new ProviderFailure("REDIRECT_REJECTED");
  if (!response.ok)
    throw new ProviderFailure(
      `PROVIDER_${response.status}`,
      mutating && response.status >= 500,
      response.status === 429 || response.status >= 500,
    );
  try {
    return JSON.parse(await boundedText(response));
  } catch (e) {
    if (e instanceof ProviderFailure) throw e;
    throw new ProviderFailure("INVALID_PROVIDER_RESPONSE", mutating);
  }
}
