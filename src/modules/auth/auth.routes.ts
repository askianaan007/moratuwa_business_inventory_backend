import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { loginLimiter } from "../../middlewares/security.js";
import * as controller from "./auth.controller.js";

export const authRoutes = Router();

authRoutes.post("/login", loginLimiter, controller.login);
authRoutes.post("/refresh", controller.refresh);
authRoutes.post("/logout", controller.logout);
authRoutes.get("/me", authenticate, controller.me);
authRoutes.post("/change-password", authenticate, controller.changePassword);
