import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { currentUser } from "../../middlewares/authenticate.js";
import * as dashboardService from "./dashboard.service.js";

const summaryQuery = z.object({ departmentId: z.uuid().optional() });

async function summary(req: Request, res: Response) {
  const { departmentId } = summaryQuery.parse(req.query);
  res.json({ data: await dashboardService.summary(currentUser(req), departmentId) });
}

export const dashboardRoutes = Router();
dashboardRoutes.get("/summary", summary);
