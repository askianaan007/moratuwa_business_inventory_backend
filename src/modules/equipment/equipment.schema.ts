import { z } from "zod";
import { EquipmentScope } from "../../generated/prisma/client.js";
import { WALLS } from "../rooms/plan-geometry.js";

export const idParams = z.object({ id: z.uuid() });
export const roomParams = z.object({ roomId: z.uuid() });

const optional = (max: number) => z.string().trim().max(max).nullish();
const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{2,20}$/, "Use 2–20 letters, numbers or dashes, e.g. MON-07");
const percent = z.number().min(0).max(100);
const version = z.number().int().min(0);
const reason = z.string().trim().min(2, "Give a reason").max(500);

export const listEquipmentQuery = z.object({
  includeRetired: z.stringbool().default(false),
});

/** A PC component (workstationId) or a room fixture (no workstationId). */
export const createEquipmentSchema = z.object({
  typeId: z.uuid(),
  workstationId: z.uuid().nullish(),
  slot: z.number().int().min(1).max(4).default(1),
  code: code.optional(),
  number: z.number().int().min(0).max(9999).optional(),
  brand: optional(80),
  modelNo: optional(80),
  serialNo: optional(120),
  wall: z.enum(WALLS).nullish(),
  x: percent.nullish(),
  y: percent.nullish(),
  notes: optional(500),
});

export const updateEquipmentSchema = z
  .object({
    code,
    number: z.number().int().min(0).max(9999),
    brand: optional(80),
    modelNo: optional(80),
    serialNo: optional(120),
    wall: z.enum(WALLS).nullable(),
    x: percent.nullable(),
    y: percent.nullable(),
    notes: optional(500),
  })
  .partial()
  .extend({ expectedVersion: version });

export const replaceEquipmentSchema = z.object({
  expectedVersion: version,
  reason,
  /** RETIRED: written off. AT_REPAIR: the old unit may come back later. */
  oldState: z.enum(["RETIRED", "AT_REPAIR"]).default("RETIRED"),
  code: code.optional(), // default: keep the same code (same sticker on the desk)
  brand: optional(80),
  modelNo: optional(80),
  serialNo: optional(120),
  assetItemId: z.uuid().nullish(),
});

export const moveEquipmentSchema = z.object({
  expectedVersion: version,
  reason,
  workstationId: z.uuid().nullable(), // null → becomes a room fixture / unassigned
  slot: z.number().int().min(1).max(4).default(1),
});

export const stateChangeSchema = z.object({ expectedVersion: version, reason });
export const returnSchema = z.object({ expectedVersion: version, reason: reason.optional() });

export const linkAssetSchema = z.object({ expectedVersion: version, assetItemId: z.uuid() });
export const unlinkAssetSchema = z.object({ expectedVersion: version });

export const generateQuery = z.object({ dryRun: z.stringbool().default(false) });
/** Without typeId: every default type. With it: only that type (e.g. UPS). */
export const generateBody = z.object({ typeId: z.uuid().optional() });

// ─── Types & fault reasons ──────────────────────────────────────────────

export const createTypeSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{2,10}$/, "Use 2–10 letters or numbers, e.g. HDS"),
  name: z.string().trim().min(2).max(60),
  scope: z.enum(EquipmentScope),
  codePrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{2,6}$/, "Use 2–6 letters or numbers, e.g. HDS"),
  isPrimary: z.boolean().default(false),
  isDefault: z.boolean().default(false),
  isAuditable: z.boolean().default(true),
  maxPerWorkstation: z.number().int().min(1).max(4).default(1),
  categoryId: z.uuid().nullish(),
  sortOrder: z.number().int().min(0).max(999).default(100),
});

export const updateTypeSchema = createTypeSchema.omit({ code: true }).partial().extend({ isActive: z.boolean().optional() });

export const listReasonsQuery = z.object({ typeId: z.uuid().optional(), includeInactive: z.stringbool().default(false) });

export const createReasonSchema = z.object({
  typeId: z.uuid().nullish(),
  label: z.string().trim().min(2).max(80),
  group: z.enum(["HARDWARE", "SOFTWARE", "POWER", "CABLE", "PHYSICAL", "NETWORK", "OTHER"]).default("OTHER"),
  sortOrder: z.number().int().min(0).max(999).default(100),
});

export const updateReasonSchema = createReasonSchema.partial().extend({ isActive: z.boolean().optional() });

export type CreateEquipmentInput = z.infer<typeof createEquipmentSchema>;
export type UpdateEquipmentInput = z.infer<typeof updateEquipmentSchema>;
export type ReplaceEquipmentInput = z.infer<typeof replaceEquipmentSchema>;
export type MoveEquipmentInput = z.infer<typeof moveEquipmentSchema>;
