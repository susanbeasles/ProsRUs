export function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}
export function decode(value: string) {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
async function importKey(key: Uint8Array) {
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(key),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function seal(key: Uint8Array, owner: string, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(owner) },
    await importKey(key),
    new TextEncoder().encode(value),
  );
  return { iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
}
export async function unseal(
  key: Uint8Array,
  owner: string,
  value: { iv: string; ciphertext: string },
) {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decode(value.iv),
      additionalData: new TextEncoder().encode(owner),
    },
    await importKey(key),
    decode(value.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}
export async function digest(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
}
