import { z } from "zod";
import { demand } from "../domain/model";
import { boundedJson } from "../providers/http";
import { createGoogle } from "../providers/google";
import { decode, encode, seal, unseal, digest } from "./vault";
export type GoogleConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  key: string;
};
const scopes = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/drive.file",
];
export function createGoogleAuth(
  db: D1Database,
  owner: string,
  config: GoogleConfig,
) {
  function validateConfig() {
    demand(
      config.clientId && config.clientSecret && config.key,
      "GOOGLE_NOT_CONFIGURED",
      503,
    );
    demand(decode(config.key).length === 32, "INVALID_ENCRYPTION_KEY", 503);
  }
  async function token(body: URLSearchParams) {
    return z
      .object({
        access_token: z.string(),
        refresh_token: z.string().optional(),
        expires_in: z.number(),
        scope: z.string().optional(),
      })
      .parse(
        await boundedJson(fetch, "https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        }),
      );
  }
  return {
    async start() {
      validateConfig();
      const state = encode(crypto.getRandomValues(new Uint8Array(32))).replace(
        /[+/=]/g,
        "",
      );
      const verifier = encode(crypto.getRandomValues(new Uint8Array(48)))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
      const hash = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier),
        ),
      );
      const challenge = encode(hash)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
      await db
        .prepare(
          "INSERT INTO oauth_states(digest,owner,expires_at,verifier) VALUES(?,?,?,?)",
        )
        .bind(await digest(state), owner, Date.now() + 600000, verifier)
        .run();
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        response_type: "code",
        scope: scopes.join(" "),
        state,
        access_type: "offline",
        prompt: "consent",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    },
    async finish(code: string, state: string) {
      validateConfig();
      const saved = await db
        .prepare(
          "DELETE FROM oauth_states WHERE digest=? AND owner=? AND expires_at>? RETURNING verifier",
        )
        .bind(await digest(state), owner, Date.now())
        .first<{ verifier: string }>();
      demand(saved, "INVALID_OAUTH_STATE");
      const result = await token(
        new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.redirectUri,
          code,
          code_verifier: saved.verifier,
          grant_type: "authorization_code",
        }),
      );
      demand(result.refresh_token, "MISSING_REFRESH_TOKEN");
      const profile = await createGoogle(result.access_token).profile();
      const sealed = await seal(
        decode(config.key),
        owner,
        result.refresh_token,
      );
      await db
        .prepare(
          "INSERT INTO credentials(owner,provider,ciphertext,iv,updated_at) VALUES(?,'google',?,?,?) ON CONFLICT(owner,provider) DO UPDATE SET ciphertext=excluded.ciphertext,iv=excluded.iv,updated_at=excluded.updated_at",
        )
        .bind(owner, sealed.ciphertext, sealed.iv, Date.now())
        .run();
      return { email: profile.emailAddress, scope: result.scope };
    },
    async client() {
      validateConfig();
      const saved = await db
        .prepare(
          "SELECT ciphertext,iv FROM credentials WHERE owner=? AND provider='google'",
        )
        .bind(owner)
        .first<{ ciphertext: string; iv: string }>();
      demand(saved, "GOOGLE_NOT_CONNECTED", 503);
      const refresh = await unseal(decode(config.key), owner, saved);
      const result = await token(
        new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          refresh_token: refresh,
          grant_type: "refresh_token",
        }),
      );
      return createGoogle(result.access_token);
    },
  };
}
