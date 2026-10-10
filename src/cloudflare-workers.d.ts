// Worker and Node globals cannot coexist in one strict ambient context.
// Node's actual createHash is checked separately against this finite port.
declare module "node:crypto" {
  export const createHash: import("./domain/hash-port").HashFactory;
}
