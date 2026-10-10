import { DomainError } from "../domain/model";
import { ProviderFailure } from "../providers/http";
export function failureDisposition(
  error: unknown,
  attempts: number,
  hasReceipt: boolean,
) {
  if (hasReceipt) return attempts < 4 ? "reproject" : "failed";
  if (error instanceof ProviderFailure && error.ambiguous) return "ambiguous";
  if (error instanceof ProviderFailure && error.retryable && attempts < 4)
    return "retry";
  if (error instanceof DomainError) return "blocked";
  return "failed";
}
