import { z } from "zod";
import { ApprovalStatus, BookStatus } from "../../generated/prisma/client.js";
import { paginationSchema } from "../../utils/pagination.js";

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  text(max)
    .optional()
    .transform((value) => value || undefined);

/** LKR amount with up to 2 decimals. Accepts "1500", "1500.50" or 1500.5. */
const money = z.coerce
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, "Enter an amount like 1500 or 1500.50");

/** Mirrors the columns of the physical ledger book. */
export const createLedgerEntrySchema = z
  .object({
    departmentId: z.uuid().optional(), // admins only; others use their own department
    entryDate: z.iso.date(),
    refNo: optionalText(60),
    description: text(500).min(2, "Description is required"),
    brand: optionalText(120),
    modelNo: optionalText(120),
    quantity: z.coerce.number().int().min(1).max(10_000),
    unitPrice: money,
    remark: optionalText(1000),
    category: optionalText(60),
    bookVolume: optionalText(30),
    bookPage: z.coerce.number().int().min(1).max(100_000).optional(),

    /** Where the items are placed. */
    locationId: z.uuid().optional(),
    /** Consumables: one bulk record instead of one tag per unit. */
    isBulk: z.boolean().default(false),
    /** One serial number per unit, in order. May be shorter than quantity. */
    serialNos: z.array(text(120)).max(10_000).default([]),
  })
  .refine((entry) => entry.serialNos.length <= entry.quantity, {
    path: ["serialNos"],
    message: "More serial numbers than quantity",
  });

/** Quantity is fixed after creation because it owns the tagged items. */
export const updateLedgerEntrySchema = z
  .object({
    entryDate: z.iso.date(),
    refNo: optionalText(60),
    description: text(500).min(2),
    brand: optionalText(120),
    modelNo: optionalText(120),
    unitPrice: money,
    remark: optionalText(1000),
    category: optionalText(60),
  })
  .partial();

export const listLedgerQuery = paginationSchema.extend({
  departmentId: z.uuid().optional(),
  q: z.string().trim().max(100).optional(),
  bookStatus: z.enum(BookStatus).optional(),
  approvalStatus: z.enum(ApprovalStatus).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

export const markWrittenSchema = z.object({
  bookVolume: optionalText(30),
  bookPage: z.coerce.number().int().min(1).max(100_000),
});

export const decisionSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  comment: optionalText(1000),
});

export const idParams = z.object({ id: z.uuid() });

export type CreateLedgerEntryInput = z.infer<typeof createLedgerEntrySchema>;
export type UpdateLedgerEntryInput = z.infer<typeof updateLedgerEntrySchema>;
export type ListLedgerQuery = z.infer<typeof listLedgerQuery>;
export type MarkWrittenInput = z.infer<typeof markWrittenSchema>;
export type DecisionInput = z.infer<typeof decisionSchema>;
