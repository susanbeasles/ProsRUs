import type { Coordinator } from "./jobs/coordinator";
// Runtime-generated binding declarations are maintained by `npm run bindings`.
export type Environment = {
  [K in keyof Cloudflare.Env]: Cloudflare.Env[K] extends string
    ? string
    : Cloudflare.Env[K];
} & {
  AUDITED_SOURCE_PROFILE?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_PUBSUB_SERVICE_ACCOUNT?: string;
  CREDENTIAL_KEY?: string;
  /** Public `recovery-trust-root-v1` JSON for Control's signing key; absent
   * means versioned saves fail closed with signing unavailable. */
  RECOVERY_TRUST_ROOT?: string;
  /** Release builder's plain_text `release-marker/v1` canonical JSON; absent
   * locally, where the committed placeholder is served. */
  RELEASE_MARKER?: string;
  CONTROL_AUTHORITY: import("./application/shared-read-authority").ControlAuthority;
  COORDINATOR: DurableObjectNamespace<Coordinator>;
};
