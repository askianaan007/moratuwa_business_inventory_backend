import { z } from "zod";
import { RoomType, SeatKind } from "../../generated/prisma/client.js";

export const idParams = z.object({ id: z.uuid() });

const locationCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{2,30}$/, "Use letters, numbers and dashes, e.g. ELEC-LAB-02");

const roomKind = z.enum(RoomType).extract(["LAB", "CLASSROOM"]);

export const listRoomsQuery = z.object({
  departmentId: z.uuid().optional(),
  roomType: roomKind.optional(),
});

/** Either turn an existing location into a room, or create a new one. */
export const createRoomSchema = z.union([
  z.object({ locationId: z.uuid(), roomType: roomKind }),
  z.object({
    departmentId: z.uuid().optional(),
    code: locationCode,
    name: z.string().trim().min(2).max(120),
    building: z.string().trim().max(120).optional(),
    floor: z.string().trim().max(30).optional(),
    roomType: roomKind,
  }),
]);

export const updateRoomSchema = z
  .object({
    code: locationCode,
    name: z.string().trim().min(2).max(120),
    building: z.string().trim().max(120).nullable(),
    floor: z.string().trim().max(30).nullable(),
    roomType: roomKind,
  })
  .partial();

const seatInput = z.object({
  id: z.uuid().optional(),
  kind: z.enum(SeatKind),
  note: z.string().trim().max(120).nullish(),
});

const rowInput = z.object({
  id: z.uuid().optional(),
  label: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{1,4}$/, "Row labels are 1–4 letters or numbers"),
  seats: z.array(seatInput).max(30, "At most 30 seats per row"),
});

const blockInput = z.object({
  id: z.uuid().optional(),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,4}$/, "Block codes are 1–4 letters or numbers, e.g. A"),
  name: z.string().trim().min(1).max(60),
  /** Number seats from the right-hand end: the right-most seat is S1. */
  seatsFromRight: z.boolean().default(false),
  rows: z.array(rowInput).min(1, "A block needs at least one row").max(40),
});

export const layoutSchema = z
  .object({
    expectedLayoutVersion: z.number().int().min(0),
    blocks: z.array(blockInput).min(1, "Add at least one block").max(12),
    /** Create a workstation for every PC seat that has none. */
    createWorkstations: z.boolean().default(true),
    /** Add default equipment (Monitor, CPU …) to workstations that lack it. */
    generateEquipment: z.boolean().default(true),
  })
  .refine((v) => v.blocks.flatMap((b) => b.rows.flatMap((r) => r.seats)).length <= 400, {
    message: "A room can have at most 400 seats",
    path: ["blocks"],
  });

export const renumberSchema = z.object({ expectedLayoutVersion: z.number().int().min(0) });

export const createWorkstationSchema = z.object({
  seatId: z.uuid(),
  generateEquipment: z.boolean().default(true),
});

export const updateWorkstationSchema = z.object({
  expectedVersion: z.number().int().min(0),
  labelOverride: z.string().trim().max(30).nullable(),
});

export const moveWorkstationSchema = z.object({
  expectedVersion: z.number().int().min(0),
  seatId: z.uuid(),
});

export const retireWorkstationSchema = z.object({
  expectedVersion: z.number().int().min(0),
  reason: z.string().trim().min(2).max(500),
  retireEquipment: z.boolean().default(false),
});

export type CreateRoomInput = z.infer<typeof createRoomSchema>;
export type UpdateRoomInput = z.infer<typeof updateRoomSchema>;
export type LayoutInput = z.infer<typeof layoutSchema>;
