import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import type { Role } from "../../generated/prisma/client.js";
import { logActivity } from "../../utils/activity-log.js";
import { AppError } from "../../utils/app-error.js";
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "../../utils/password.js";
import { generateRefreshToken, hashToken, signAccessToken } from "../../utils/tokens.js";
import type { ChangePasswordInput, LoginInput } from "./auth.schema.js";

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

const INVALID_CREDENTIALS = new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");

export const publicUserSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  departmentId: true,
  department: { select: { id: true, code: true, name: true } },
} as const;

interface ClientInfo {
  ip?: string;
  userAgent?: string;
}

async function issueTokens(user: { id: string; role: Role }, familyId: string, client: ClientInfo) {
  const refreshToken = generateRefreshToken();
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      familyId,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
      ip: client.ip,
      userAgent: client.userAgent?.slice(0, 255),
    },
  });
  const accessToken = await signAccessToken({ sub: user.id, role: user.role });
  return { accessToken, refreshToken };
}

export async function login(input: LoginInput, client: ClientInfo) {
  const user = await prisma.user.findUnique({ where: { email: input.email } });

  if (!user) {
    await verifyPassword(input.password, DUMMY_PASSWORD_HASH); // equalise timing
    throw INVALID_CREDENTIALS;
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw AppError.locked("Too many failed attempts. The account is locked for a few minutes.");
  }

  const valid = await verifyPassword(input.password, user.passwordHash);
  if (!valid || !user.isActive) {
    const failed = user.failedLoginCount + 1;
    const lock = failed >= MAX_FAILED_LOGINS;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: lock ? 0 : failed,
        lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000) : user.lockedUntil,
      },
    });
    if (lock) logger.warn({ userId: user.id, ip: client.ip }, "Account locked after repeated failed logins");
    throw INVALID_CREDENTIALS;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });
  await logActivity(prisma, { actorId: user.id, action: "login", tableName: "users", rowId: user.id, after: { ip: client.ip } });

  const tokens = await issueTokens(user, randomUUID(), client);
  const profile = await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: publicUserSelect });
  return { ...tokens, user: profile };
}

/**
 * Rotates the refresh token. Every refresh token is single-use: presenting
 * one that was already rotated means it was copied, so the whole login
 * session (token family) is revoked.
 */
export async function refresh(presented: string | undefined, client: ClientInfo) {
  if (!presented) throw AppError.unauthorized();

  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(presented) },
    include: { user: { select: { id: true, role: true, isActive: true } } },
  });
  if (!stored) throw AppError.unauthorized();

  if (stored.revokedAt || stored.replacedAt) {
    await prisma.refreshToken.updateMany({
      where: { familyId: stored.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    logger.warn({ userId: stored.userId, familyId: stored.familyId, ip: client.ip }, "Refresh token reuse detected");
    throw AppError.unauthorized();
  }
  if (stored.expiresAt < new Date() || !stored.user.isActive) throw AppError.unauthorized();

  // Mark as used only if nobody else used it first (guards against races).
  const { count } = await prisma.refreshToken.updateMany({
    where: { id: stored.id, replacedAt: null, revokedAt: null },
    data: { replacedAt: new Date() },
  });
  if (count === 0) throw AppError.unauthorized();

  return issueTokens(stored.user, stored.familyId, client);
}

/** Revokes the current login session. Always succeeds. */
export async function logout(presented: string | undefined) {
  if (!presented) return;
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(presented) } });
  if (!stored) return;
  await prisma.refreshToken.updateMany({
    where: { familyId: stored.familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function changePassword(userId: string, input: ChangePasswordInput) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
    throw new AppError(400, "INVALID_PASSWORD", "Current password is incorrect");
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(input.newPassword) } });
    // Sign out every device.
    await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await logActivity(tx, { actorId: userId, action: "change_password", tableName: "users", rowId: userId });
  });
}

export function getProfile(userId: string) {
  return prisma.user.findUniqueOrThrow({ where: { id: userId }, select: publicUserSelect });
}
