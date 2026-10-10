import { it, expect } from "vitest";
import { messageText } from "../src/jobs/mail";
it("reads authoritative plain text MIME content without executing attachments", () => {
  expect(
    messageText({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: btoa("Interview details") } },
        {
          mimeType: "application/javascript",
          body: { data: btoa("throw secret") },
        },
      ],
    }),
  ).toBe("Interview details");
});
