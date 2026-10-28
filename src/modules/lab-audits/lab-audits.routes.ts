import { Router, type Request, type Response } from "express";
import { authorize, currentUser } from "../../middlewares/authenticate.js";
import { renderDocx } from "../reports/report-docx.js";
import { renderPdf } from "../reports/report-pdf.js";
import {
  bulkSchema,
  decisionSchema,
  idParams,
  listAuditsQuery,
  overviewQuery,
  reopenSchema,
  reportQuery,
  startAuditSchema,
  updateAuditSchema,
  updateChecksSchema,
  versionSchema,
} from "./lab-audits.schema.js";
import * as audits from "./lab-audits.service.js";

const auditors = authorize("ADMIN", "HOD", "TECHNICAL_OFFICER");
const approvers = authorize("ADMIN", "HOD");
const admins = authorize("ADMIN");

// ─── Handlers ───────────────────────────────────────────────────────────

async function list(req: Request, res: Response) {
  res.json(await audits.list(currentUser(req), listAuditsQuery.parse(req.query)));
}

async function overview(req: Request, res: Response) {
  res.json({ data: await audits.overview(currentUser(req), overviewQuery.parse(req.query)) });
}

async function get(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await audits.get(currentUser(req), id) });
}

async function start(req: Request, res: Response) {
  res.status(201).json({ data: await audits.start(currentUser(req), startAuditSchema.parse(req.body)) });
}

async function updateHeader(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await audits.updateHeader(currentUser(req), id, updateAuditSchema.parse(req.body)) });
}

async function updateChecks(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  const { changes } = updateChecksSchema.parse(req.body);
  res.json({ data: await audits.updateChecks(currentUser(req), id, changes) });
}

async function bulk(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await audits.bulk(currentUser(req), id, bulkSchema.parse(req.body)) });
}

async function previewTargets(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await audits.previewTargets(currentUser(req), id) });
}

async function syncTargets(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  const { expectedVersion } = versionSchema.parse(req.body);
  res.json({ data: await audits.syncTargets(currentUser(req), id, expectedVersion) });
}

async function submit(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  const { expectedVersion } = versionSchema.parse(req.body);
  res.json({ data: await audits.submit(currentUser(req), id, expectedVersion) });
}

async function decide(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await audits.decide(currentUser(req), id, decisionSchema.parse(req.body)) });
}

async function reopen(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await audits.reopen(currentUser(req), id, reopenSchema.parse(req.body)) });
}

async function report(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  const { revision } = reportQuery.parse(req.query);
  const { data, revision: rev } = await audits.reportData(currentUser(req), id, revision);
  res.json({ data, meta: { revision: rev } });
}

/** Both formats come from the same frozen snapshot, so they always agree. */
function download(format: "pdf" | "docx") {
  return async (req: Request, res: Response) => {
    const { id } = idParams.parse(req.params);
    const { revision } = reportQuery.parse(req.query);
    const { data, revision: rev } = await audits.reportData(currentUser(req), id, revision);
    const file = format === "pdf" ? await renderPdf(data) : await renderDocx(data);
    const name = `${data.audit.reference}${rev ? `-rev${rev}` : "-DRAFT"}.${format}`;
    res
      .status(200)
      .type(format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
      .setHeader("Content-Disposition", `${req.query.inline === "1" && format === "pdf" ? "inline" : "attachment"}; filename="${name}"`)
      .send(file);
  };
}

async function discrepancies(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await audits.discrepancies(currentUser(req), id) });
}

// ─── Routes ─────────────────────────────────────────────────────────────

export const labAuditsRoutes = Router();
labAuditsRoutes.get("/", list);
labAuditsRoutes.get("/overview", overview);
labAuditsRoutes.post("/", auditors, start);
labAuditsRoutes.get("/:id", get);
labAuditsRoutes.patch("/:id", auditors, updateHeader);
labAuditsRoutes.patch("/:id/checks", auditors, updateChecks);
labAuditsRoutes.post("/:id/checks/bulk", auditors, bulk);
labAuditsRoutes.post("/:id/targets/preview", auditors, previewTargets);
labAuditsRoutes.post("/:id/targets/sync", auditors, syncTargets);
labAuditsRoutes.post("/:id/submit", auditors, submit);
labAuditsRoutes.post("/:id/decision", approvers, decide);
labAuditsRoutes.post("/:id/reopen", admins, reopen);
labAuditsRoutes.get("/:id/report", report);
labAuditsRoutes.get("/:id/report.pdf", download("pdf"));
labAuditsRoutes.get("/:id/report.docx", download("docx"));
labAuditsRoutes.get("/:id/discrepancies", discrepancies);
