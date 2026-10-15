import { createHash } from "node:crypto";
import type { HashFactory } from "../../src/domain/hash-port";
const checked: HashFactory = createHash;
checked("sha256").update(new Uint8Array()).digest("hex");
// @ts-expect-error The runtime port never exposes other algorithms.
checked("md5");
