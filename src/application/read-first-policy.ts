/** No legacy operation or external effect has current exact action authority.
 * Full write integration must replace this denial with the reviewed finite adapter. */
export function denyLegacyEffect(): void {
  throw Error("operation-unavailable");
}
