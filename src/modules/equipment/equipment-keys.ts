import type { Prisma } from "../../generated/prisma/client.js";
import { AppError } from "../../utils/app-error.js";
import { pad } from "../rooms/room-view.js";

/**
 * Builders for the nullable "active key" unique columns. A live row carries
 * its key; a retired row gets null, so history never blocks reuse of a code.
 */
export const codeKey = (locationId: string, code: string) => `${locationId}:${code.toUpperCase()}`;
export const slotKey = (workstationId: string, typeId: string, slot: number) => `${workstationId}:${typeId}:${slot}`;
export const numberKey = (locationId: string, number: number) => `${locationId}:${number}`;

export const equipmentCode = (prefix: string, number: number) => `${prefix}-${pad(number)}`;

/**
 * Gives every placed workstation in the room one item of each active default
 * type it is missing (MON-07, CPU-07 … numbered after the PC), or of just
 * `onlyTypeId` when given (e.g. UPS, which is not a default). Codes already
 * taken in the room are skipped and reported, never overwritten.
 */
export async function generateDefaultEquipment(tx: Prisma.TransactionClient, locationId: string, departmentId: string, onlyTypeId?: string) {
  const types = await tx.equipmentType.findMany({
    where: { isActive: true, scope: { in: ["WORKSTATION", "BOTH"] }, ...(onlyTypeId ? { id: onlyTypeId } : { isDefault: true }) },
    orderBy: { sortOrder: "asc" },
  });
  if (onlyTypeId && !types.length) throw AppError.badRequest("That equipment type cannot be added to PCs");
  const workstations = await tx.workstation.findMany({
    where: { locationId, deletedAt: null, seatId: { not: null } },
    orderBy: { number: "asc" },
  });
  const existing = await tx.equipment.findMany({
    where: { locationId, state: { not: "RETIRED" } },
    select: { workstationId: true, typeId: true, activeCodeKey: true },
  });

  const takenCodes = new Set(existing.map((e) => e.activeCodeKey).filter(Boolean));
  const hasType = new Set(existing.map((e) => `${e.workstationId}:${e.typeId}`));
  const data: Prisma.EquipmentCreateManyInput[] = [];
  const skipped: string[] = [];

  for (const ws of workstations) {
    for (const type of types) {
      if (hasType.has(`${ws.id}:${type.id}`)) continue;
      const code = equipmentCode(type.codePrefix, ws.number);
      const key = codeKey(locationId, code);
      if (takenCodes.has(key)) {
        skipped.push(code);
        continue;
      }
      takenCodes.add(key);
      data.push({
        departmentId,
        locationId,
        workstationId: ws.id,
        typeId: type.id,
        slot: 1,
        code,
        number: ws.number,
        activeCodeKey: key,
        activeSlotKey: slotKey(ws.id, type.id, 1),
      });
    }
  }
  if (data.length) await tx.equipment.createMany({ data });
  return { created: data.length, skipped };
}
