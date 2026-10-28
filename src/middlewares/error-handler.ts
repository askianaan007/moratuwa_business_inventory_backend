import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { Prisma } from "../generated/prisma/client.js";
import { AppError } from "../utils/app-error.js";

export function notFoundHandler(req: Request, _res: Response, next: NextFunction) {
  next(new AppError(404, "ROUTE_NOT_FOUND", `Route ${req.method} ${req.path} not found`));
}

/**
 * Converts every thrown error into a consistent JSON shape:
 *   { error: { code, message, details?, requestId } }
 * Internal errors are logged in full but only a generic message is returned.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = String(req.id);
  const send = (status: number, code: string, message: string, details?: unknown) =>
    res.status(status).json({ error: { code, message, ...(details ? { details } : {}), requestId } });

  if (err instanceof AppError) {
    if (err.status >= 500) req.log.error({ err }, err.message);
    return send(err.status, err.code, err.message, err.details);
  }

  if (err instanceof ZodError) {
    const details = err.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
    return send(400, "VALIDATION_ERROR", "Some fields are invalid", details);
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") return send(409, "CONFLICT", "A record with these details already exists");
    if (err.code === "P2025") return send(404, "NOT_FOUND", "Record not found");
  }

  // Malformed JSON body from express.json()
  if (err instanceof SyntaxError && "status" in err && err.status === 400) {
    return send(400, "INVALID_JSON", "Request body is not valid JSON");
  }
  if (typeof err === "object" && err !== null && "type" in err && err.type === "entity.too.large") {
    return send(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
  }

  req.log.error({ err }, "Unhandled error");
  return send(500, "INTERNAL_ERROR", "Something went wrong. Please try again.");
}
