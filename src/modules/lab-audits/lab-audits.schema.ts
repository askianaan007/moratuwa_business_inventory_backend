import { z } from "zod";
import { LabAuditStatus, LabCheckStatus } from "../../generated/prisma/client.js";
import { paginationSchema } from "../../utils/pagination.js";

export const idParams = z.object({ id: z.uuid() });

/** "2026-10" → first day of that month. */
export const periodString = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM, e.g. 2026-10");

const version = z.number().int().min(0);
const mutationId = z.uuid();
const optional = (max: number) => z.string().trim().max(max).nullish();

export const listAuditsQuery = paginationSchema.extend({
  departmentId: z.uuid().optional(),
  roomId: z.uuid().optional(),
  period: periodString.optional(),
  status: z.enum(LabAuditStatus).optional(),
});

export const overviewQuery = z.object({ departmentId: z.uuid().optional(), period: periodString.optional() });

export const startAuditSchema = z.object({
  roomId: z.uuid(),
  period: periodString,
  auditorName: z.string().trim().min(2).max(120),
  auditorDesignation: optional(120),
  startedOn: z.iso.date(),
  copyFromPrevious: z.boolean().default(true),
});

export const updateAuditSchema = z
  .object({
    auditorName: z.string().trim().min(2).max(120),
    auditorDesignation: optional(120),
    startedOn: z.iso.date(),
    completedOn: z.iso.date().nullable(),
    generalRemarks: optional(4000),
    recommendations: optional(4000),
  })
  .partial()
  .extend({ expectedVersion: version });

const checkChange = z.object({
  checkId: z.uuid(),
  expectedVersion: version,
  mutationId,
  status: z.enum(LabCheckStatus),
  faultReasonId: z.uuid().nullish(),
  reasonText: optional(500),
  notes: optional(1000),
  actionTaken: optional(500),
  followUp: optional(500),
});

export const updateChecksSchema = z.object({
  changes: z.array(checkChange).min(1).max(50),
});

export const bulkSchema = z.object({
  mutationId,
  scope: z.union([z.object({ workstationId: z.uuid() }), z.object({ rowId: z.uuid() })]),
  status: z.literal("WORKING"),
  onlyUnchecked: z.boolean().default(true),
});

export const versionSchema = z.object({ expectedVersion: version });

export const decisionSchema = z
  .object({
    expectedVersion: version,
    decision: z.enum(["APPROVED", "RETURNED"]),
    comment: optional(1000),
  })
  .refine((v) => v.decision === "APPROVED" || (v.comment && v.comment.length >= 3), {
    message: "Say what needs correcting",
    path: ["comment"],
  });

export const reopenSchema = z.object({ expectedVersion: version, reason: z.string().trim().min(3).max(1000) });

export const reportQuery = z.object({ revision: z.coerce.number().int().min(1).optional() });

export type StartAuditInput = z.infer<typeof startAuditSchema>;
export type UpdateAuditInput = z.infer<typeof updateAuditSchema>;
export type CheckChange = z.infer<typeof checkChange>;
export type BulkInput = z.infer<typeof bulkSchema>;
export type ListAuditsQuery = z.infer<typeof listAuditsQuery>;
