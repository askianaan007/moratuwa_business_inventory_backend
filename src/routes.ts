import { Router } from "express";
import { prisma } from "./lib/prisma.js";
import { authenticate } from "./middlewares/authenticate.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { dashboardRoutes } from "./modules/dashboard/dashboard.routes.js";
import { itemsRoutes } from "./modules/items/items.routes.js";
import { ledgerRoutes } from "./modules/ledger/ledger.routes.js";
import { organisationRoutes } from "./modules/organisation/organisation.routes.js";
import { usersRoutes } from "./modules/users/users.routes.js";

export const apiRoutes = Router();

// ─── Public ─────────────────────────────────────────────────────────────
apiRoutes.get("/health", async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  res.json({ status: "ok", time: new Date().toISOString() });
});
apiRoutes.use("/auth", authRoutes);

// ─── Everything below requires a signed-in user ────────────────────────
apiRoutes.use(authenticate);
apiRoutes.use("/dashboard", dashboardRoutes);
apiRoutes.use("/ledger", ledgerRoutes);
apiRoutes.use("/items", itemsRoutes);
apiRoutes.use("/users", usersRoutes);
apiRoutes.use("/", organisationRoutes); // /departments, /locations
