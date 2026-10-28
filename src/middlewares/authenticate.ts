import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { AppError } from "../utils/app-error.js";
import { ACCESS_COOKIE } from "../utils/cookies.js";
import { verifyAccessToken } from "../utils/tokens.js";
import type { Role } from "../generated/prisma/client.js";

function readToken(req: Request): string | undefined {
  const cookieToken: unknown = req.cookies?.[ACCESS_COOKIE];
  if (typeof cookieToken === "string" && cookieToken) return cookieToken;

  // Non-browser clients (scripts, future native app) may send a bearer token.
  const header = req.get("authorization");
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return undefined;
}

/**
 * Verifies the access token and loads the user. The user is re-read from the
 * database on every request so deactivating an account or changing a role
 * takes effect immediately, not when the token expires.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const token = readToken(req);
  if (!token) throw AppError.unauthorized();

  let userId: string;
  try {
    userId = (await verifyAccessToken(token)).sub;
  } catch {
    throw new AppError(401, "TOKEN_INVALID", "Session expired. Please sign in again.");
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, role: true, departmentId: true, isActive: true },
  });
  if (!user || !user.isActive) throw AppError.unauthorized();

  const { isActive: _isActive, ...authUser } = user;
  req.user = authUser;
  next();
}

/** Allows the request only for the listed roles. Use after `authenticate`. */
export function authorize(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw AppError.unauthorized();
    if (!roles.includes(req.user.role)) throw AppError.forbidden();
    next();
  };
}

/** Narrowing helper for controllers behind `authenticate`. */
export function currentUser(req: Request) {
  if (!req.user) throw AppError.unauthorized();
  return req.user;
}
