import { Router } from "express";
import { authorize } from "../../middlewares/authenticate.js";
import * as controller from "./items.controller.js";

const editors = authorize("ADMIN", "HOD", "TECHNICAL_OFFICER");

export const itemsRoutes = Router();

itemsRoutes.get("/by-tag/:tagCode", controller.getByTag);
itemsRoutes.get("/:id", controller.get);
itemsRoutes.patch("/:id", editors, controller.update);
itemsRoutes.post("/:id/move", editors, controller.move);
