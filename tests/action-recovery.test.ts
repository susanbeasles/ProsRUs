import { it, expect } from "vitest";
import { ProviderFailure } from "../src/providers/http";
import { failureDisposition } from "../src/jobs/failure";
it("retries a quota rejection but never repeats an ambiguous send", () => {
  expect(
    failureDisposition(
      new ProviderFailure("PROVIDER_429", false, true),
      1,
      false,
    ),
  ).toBe("retry");
  expect(
    failureDisposition(
      new ProviderFailure("PROVIDER_UNREACHABLE", true, true),
      1,
      false,
    ),
  ).toBe("ambiguous");
  expect(failureDisposition(new Error("projection"), 1, true)).toBe(
    "reproject",
  );
});
