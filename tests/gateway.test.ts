import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
it("production configuration cannot expose the development authentication bypass", () => {
  const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
  expect(config.main).toBe("src/worker.ts");
  expect(config.workers_dev).toBe(false);
  expect(config.preview_urls).toBe(false);
  expect(config.services).toEqual([{ binding: "CONTROL_AUTHORITY", service: "personal-control", entrypoint: "JobStackAuthority" }]);
  const worker = readFileSync("src/worker.ts", "utf8");
  expect(worker).not.toContain("from './local'");
});
