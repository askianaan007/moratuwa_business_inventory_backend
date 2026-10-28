import type { NextFunction, Request, Response } from "express";
import cors from "cors";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { env } from "../config/env.js";
import { AppError } from "../utils/app-error.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Only origins in CORS_ORIGINS may call the API from a browser with cookies. */
export const corsMiddleware = cors({
  origin(origin, callback) {
    // Same-origin and non-browser requests have no Origin header.
    if (!origin || env.CORS_ORIGINS.includes(origin)) return callback(null, true);
    callback(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
  maxAge: 600,
});

/**
 * CSRF defence in depth (cookies are already SameSite=Strict):
 * - state-changing requests from a browser must come from an allowed origin
 * - request bodies must be JSON, which a plain HTML form cannot send
 */
export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.get("origin");
  if (origin && !env.CORS_ORIGINS.includes(origin)) {
    throw AppError.forbidden("Origin not allowed");
  }

  const hasBody = Number(req.get("content-length") ?? 0) > 0 || req.get("transfer-encoding") !== undefined;
  if (hasBody && !req.is("application/json")) {
    throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Request body must be application/json");
  }
  next();
}

const limiterResponse = { error: { code: "RATE_LIMITED", message: "Too many requests. Please try again later." } };

/**
 * General limit for the whole API, per client IP. Generous enough for a
 * continuous audit session (about one scan a second).
 * Behind the Next.js proxy + Caddy, set TRUST_PROXY=1 so req.ip is the real client.
 */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 1000,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: limiterResponse,
});

/** Strict limit for login, per IP and email, to slow down password guessing. */
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === "string" ? req.body.email.toLowerCase() : "";
    // ipKeyGenerator groups IPv6 addresses by /56 subnet so one client can't rotate addresses.
    return `${ipKeyGenerator(req.ip ?? "")}:${email}`;
  },
  message: limiterResponse,
});
