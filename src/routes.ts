import { Router } from "express";
import { prisma } from "./lib/prisma.js";
import { authenticate } from "./middlewares/authenticate.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { categoriesRoutes } from "./modules/categories/categories.routes.js";
import { dashboardRoutes } from "./modules/dashboard/dashboard.routes.js";
import { equipmentRoutes, equipmentTypesRoutes, faultReasonsRoutes, roomEquipmentRoutes } from "./modules/equipment/equipment.routes.js";
import { itemsRoutes } from "./modules/items/items.routes.js";
import { labAuditsRoutes } from "./modules/lab-audits/lab-audits.routes.js";
import { ledgerRoutes } from "./modules/ledger/ledger.routes.js";
import { organisationRoutes } from "./modules/organisation/organisation.routes.js";
import { reportSettingsRoutes } from "./modules/reports/report-settings.routes.js";
import { roomsRoutes, workstationsRoutes } from "./modules/rooms/rooms.routes.js";
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
apiRoutes.use("/categories", categoriesRoutes);
apiRoutes.use("/items", itemsRoutes);
apiRoutes.use("/users", usersRoutes);
apiRoutes.use("/rooms/:roomId/equipment", roomEquipmentRoutes);
apiRoutes.use("/rooms", roomsRoutes);
apiRoutes.use("/workstations", workstationsRoutes);
apiRoutes.use("/equipment", equipmentRoutes);
apiRoutes.use("/equipment-types", equipmentTypesRoutes);
apiRoutes.use("/fault-reasons", faultReasonsRoutes);
apiRoutes.use("/lab-audits", labAuditsRoutes);
apiRoutes.use("/report-settings", reportSettingsRoutes);
apiRoutes.use("/", organisationRoutes); // /departments, /locations
