import type { Request, Response } from "express";
import { currentUser } from "../../middlewares/authenticate.js";
import { clearAuthCookies, REFRESH_COOKIE, setAuthCookies } from "../../utils/cookies.js";
import { changePasswordSchema, loginSchema } from "./auth.schema.js";
import * as authService from "./auth.service.js";

const clientInfo = (req: Request) => ({ ip: req.ip, userAgent: req.get("user-agent") });

const refreshCookie = (req: Request): string | undefined => {
  const value: unknown = req.cookies?.[REFRESH_COOKIE];
  return typeof value === "string" ? value : undefined;
};

export async function login(req: Request, res: Response) {
  const input = loginSchema.parse(req.body);
  const { accessToken, refreshToken, user } = await authService.login(input, clientInfo(req));
  setAuthCookies(res, accessToken, refreshToken);
  res.json({ data: { user } });
}

export async function refresh(req: Request, res: Response) {
  try {
    const { accessToken, refreshToken } = await authService.refresh(refreshCookie(req), clientInfo(req));
    setAuthCookies(res, accessToken, refreshToken);
    res.status(204).end();
  } catch (err) {
    clearAuthCookies(res);
    throw err;
  }
}

export async function logout(req: Request, res: Response) {
  await authService.logout(refreshCookie(req));
  clearAuthCookies(res);
  res.status(204).end();
}

export async function me(req: Request, res: Response) {
  res.json({ data: { user: await authService.getProfile(currentUser(req).id) } });
}

export async function changePassword(req: Request, res: Response) {
  const input = changePasswordSchema.parse(req.body);
  await authService.changePassword(currentUser(req).id, input);
  clearAuthCookies(res);
  res.status(204).end();
}
