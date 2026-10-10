import { it, expect } from "vitest";
import { boundedJson, ProviderFailure } from "../src/providers/http";
import { seal, unseal } from "../src/identity/vault";
import { mailMessage } from "../src/providers/google";
it("rejects provider redirects instead of forwarding credentials", async () => {
  await expect(
    boundedJson(
      async () => new Response(null, { status: 302 }),
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      {},
    ),
  ).rejects.toBeInstanceOf(ProviderFailure);
});
it("binds encrypted credentials to their owner", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const sealed = await seal(key, "owner", "refresh");
  expect(await unseal(key, "owner", sealed)).toBe("refresh");
  await expect(unseal(key, "other", sealed)).rejects.toThrow();
});
it("rejects mail header injection", () => {
  expect(() =>
    mailMessage({
      from: "owner@example.com",
      to: "test@example.com\r\nBcc:evil@example.com",
      subject: "Interview",
      body: "Hello",
      messageId: "abc@job-stack.invalid",
    }),
  ).toThrow();
});
