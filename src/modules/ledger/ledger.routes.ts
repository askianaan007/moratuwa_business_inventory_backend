import { Router } from "express";
import { authorize } from "../../middlewares/authenticate.js";
import * as controller from "./ledger.controller.js";

const editors = authorize("ADMIN", "HOD", "TECHNICAL_OFFICER");
const approvers = authorize("ADMIN", "HOD");

export const ledgerRoutes = Router();

ledgerRoutes.get("/", controller.list);
ledgerRoutes.get("/:id", controller.get);
ledgerRoutes.post("/", editors, controller.create);
ledgerRoutes.patch("/:id", editors, controller.update);
ledgerRoutes.delete("/:id", editors, controller.remove);
ledgerRoutes.post("/:id/book", editors, controller.markWritten);
ledgerRoutes.post("/:id/submit", editors, controller.submit);
ledgerRoutes.post("/:id/decision", approvers, controller.decide);
