import type { CookieOptions, Response } from "express";
import { env, isProduction } from "../config/env.js";

export const ACCESS_COOKIE = "ll_at";
export const REFRESH_COOKIE = "ll_rt";
/** The refresh cookie is only ever sent to the auth endpoints. */
const REFRESH_PATH = "/api/v1/auth";

const base: CookieOptions = {
  httpOnly: true, // not readable from JavaScript (XSS cannot steal it)
  secure: isProduction, // HTTPS only in production
  sameSite: "strict", // not sent on cross-site requests (CSRF)
};

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...base,
    path: "/",
    maxAge: env.ACCESS_TOKEN_TTL_MIN * 60 * 1000,
  });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...base,
    path: REFRESH_PATH,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { ...base, path: "/" });
  res.clearCookie(REFRESH_COOKIE, { ...base, path: REFRESH_PATH });
}
