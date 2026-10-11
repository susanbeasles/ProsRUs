// Test-only transport: execute the actual emitted source with hostile/real Responses.
export async function emittedRead(args, body, options = {}) {
  const status = options.status ?? (body === null ? 404 : 200);
  const response =
    options.response ??
    new Response(
      body === null
        ? JSON.stringify({
            success: false,
            result: null,
            errors: [{ code: 10007, message: "Synthetic missing key" }],
            messages: [],
          })
        : body,
      { status, headers: options.headers },
    );
  const clock = options.now ?? (() => 1000);
  const fetch = options.fetch ?? (async () => response);
  return new Function(
    "fetch",
    "Date",
    "setTimeout",
    "clearTimeout",
    `return (${args.code})();`,
  )(
    fetch,
    class extends Date {
      static now() {
        return clock();
      }
    },
    options.setTimeout ?? setTimeout,
    options.clearTimeout ?? clearTimeout,
  );
}
