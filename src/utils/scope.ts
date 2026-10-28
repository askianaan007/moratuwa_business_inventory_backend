import type { AuthUser } from "../types/express.js";
import { AppError } from "./app-error.js";

/**
 * Department isolation. Admins may work across departments (optionally
 * narrowed by `requested`); everyone else is pinned to their own department
 * regardless of what the client asks for.
 */
export function departmentScope(user: AuthUser, requested?: string): string | undefined {
  if (user.role === "ADMIN") return requested;
  if (!user.departmentId) throw AppError.forbidden("Your account is not assigned to a department");
  return user.departmentId;
}

/** Like departmentScope, but a single department is required (for writes). */
export function requireDepartment(user: AuthUser, requested?: string): string {
  const departmentId = departmentScope(user, requested);
  if (!departmentId) throw AppError.badRequest("departmentId is required");
  return departmentId;
}

/** Throws 404 (not 403) so records in other departments are not revealed. */
export function assertInScope(user: AuthUser, recordDepartmentId: string, what = "Record") {
  if (user.role !== "ADMIN" && user.departmentId !== recordDepartmentId) throw AppError.notFound(what);
}
