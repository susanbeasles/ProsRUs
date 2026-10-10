// The Workers runtime uses only this finite part of node:crypto.
// A separate strict Node consumer checks it against the installed actual API.
export interface HashPort {
  update(value: string | Uint8Array): HashPort;
  digest(): Uint8Array;
  digest(encoding: "hex"): string;
}
export type HashFactory = (algorithm: "sha256") => HashPort;
