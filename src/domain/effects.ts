export function effectDigestInput(
  kind: string,
  payload: Record<string, unknown>,
) {
  if (kind !== "send") return payload;
  const { revision: ignored, ...message } = payload;
  void ignored;
  return message;
}
