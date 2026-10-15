import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
// The Worker serves only /owner/job-stack and /owner/job-stack/assets/<file> with this file pattern.
const ASSET = /^[A-Za-z0-9_.-]+$/;
let out = "";

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "job-stack-dashboard-"));
  await build({
    configFile: join(root, "vite.config.ts"),
    logLevel: "silent",
    build: { outDir: out, emptyOutDir: true },
  });
}, 120_000);
afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

function files(dir: string, prefix = ""): string[] {
  return readdirSync(dir).flatMap((name) =>
    statSync(join(dir, name)).isDirectory() ? files(join(dir, name), prefix + name + "/") : [prefix + name],
  );
}

describe("built dashboard", () => {
  it("has no inline script, inline style or style attribute in index.html (CSP style-src 'self')", () => {
    const html = readFileSync(join(out, "index.html"), "utf8");
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script[^>]*>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attributes, body] of scripts) {
      expect(attributes).toMatch(/\bsrc="\/owner\/job-stack\/assets\/[A-Za-z0-9_.-]+\.js"/);
      expect(body?.trim()).toBe("");
    }
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    for (const [, href] of html.matchAll(/<link\b[^>]*href="([^"]+)"/gi)) expect(href).toMatch(/^\/owner\/job-stack\/assets\/[A-Za-z0-9_.-]+$/);
  });

  it("emits index.html plus assets that sit flat under assets/ with servable names", () => {
    const emitted = files(out);
    expect(emitted).toContain("index.html");
    for (const file of emitted.filter((f) => f !== "index.html")) {
      expect(file.startsWith("assets/"), file).toBe(true);
      const name = file.slice("assets/".length);
      expect(name.includes("/"), file).toBe(false);
      expect(name, file).toMatch(ASSET);
    }
  });

  it("splits every feature into its own lazily loaded chunk", () => {
    const names = readdirSync(join(out, "assets"));
    for (const feature of ["OverviewPage", "OpportunitiesPage", "ConversationsPage", "InterviewsPage", "ProfileEvidencePage", "PacketsPage", "ActivityPage", "SettingsPage", "HistoryPage", "RecoveryStatus"])
      expect(names.some((name) => name.startsWith(feature + "-") && name.endsWith(".js")), feature).toBe(true);
  });
});

describe("dashboard source", () => {
  const sources = files(join(root, "dashboard"))
    .filter((f) => /\.(tsx?|html)$/.test(f))
    .map((f) => [f, readFileSync(join(root, "dashboard", f), "utf8")] as const);
  it("uses no inline styles or raw HTML injection", () => {
    for (const [file, text] of sources) {
      expect(text, file).not.toMatch(/\bstyle=\{/);
      expect(text, file).not.toMatch(/\sstyle="/);
      expect(text, file).not.toMatch(/dangerouslySetInnerHTML|innerHTML\s*=|insertAdjacentHTML|document\.write/);
    }
  });
});
