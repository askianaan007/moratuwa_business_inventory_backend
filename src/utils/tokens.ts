import { createHash, randomBytes } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { env } from "../config/env.js";
import type { Role } from "../generated/prisma/client.js";

const secret = new TextEncoder().encode(env.JWT_SECRET);
const AUDIENCE = "labledger-app";

export interface AccessTokenClaims {
  sub: string;
  role: Role;
}

export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({ role: claims.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_MIN}m`)
    .sign(secret);
}

/** Throws if the token is invalid, expired, or signed for someone else. */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, secret, {
    issuer: env.JWT_ISSUER,
    audience: AUDIENCE,
    algorithms: ["HS256"],
  });
  if (typeof payload.sub !== "string") throw new Error("Token has no subject");
  return { sub: payload.sub, role: payload.role as Role };
}

/** Opaque, high-entropy refresh token. Only its hash is stored. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
