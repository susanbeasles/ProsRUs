import { createRemoteJWKSet, jwtVerify } from "jose";
import { demand } from "../domain/model";
export async function verifyPubSub(
  request: Request,
  input: { audience: string; serviceAccount: string },
) {
  demand(input.serviceAccount, "PUBSUB_NOT_CONFIGURED", 503);
  const token = request.headers
    .get("authorization")
    ?.match(/^Bearer (.+)$/)?.[1];
  demand(token, "UNAUTHENTICATED", 401);
  const keys = createRemoteJWKSet(
    new URL("https://www.googleapis.com/oauth2/v3/certs"),
  );
  const { payload } = await jwtVerify(token, keys, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: input.audience,
    algorithms: ["RS256"],
  });
  demand(
    payload.email === input.serviceAccount && payload.email_verified === true,
    "FORBIDDEN",
    403,
  );
}
