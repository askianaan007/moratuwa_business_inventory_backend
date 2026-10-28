/**
 * MOCK DATA ONLY. Turns DEMO-LAB-02 (from the main seed) into a configured lab
 * so the lab audit screens can be tried out: two blocks of eight rows with
 * empty tables, a short row, a gap, an instructor desk and room equipment.
 * Every code and serial number here is invented.
 *
 * Usage (after `npm run db:seed`): npm run db:seed:lab-demo
 */
import { prisma } from "../src/lib/prisma.js";
import * as equipment from "../src/modules/equipment/equipment.service.js";
import * as rooms from "../src/modules/rooms/rooms.service.js";
import type { AuthUser } from "../src/types/express.js";

type Kind = "PC" | "EMPTY_TABLE" | "NO_TABLE" | "INSTRUCTOR";
const pcs = (n: number): { kind: Kind }[] => Array.from({ length: n }, () => ({ kind: "PC" }));

async function main() {
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN", isActive: true } });
  if (!admin) throw new Error("Run `npm run db:seed` first (needs an admin)");
  const user: AuthUser = { id: admin.id, name: admin.name, email: admin.email, role: admin.role, departmentId: admin.departmentId };

  const department = await prisma.department.findUniqueOrThrow({ where: { code: "DEMO" } });
  const lab = await prisma.location.findUniqueOrThrow({ where: { departmentId_code: { departmentId: department.id, code: "DEMO-LAB-02" } } });
  if (await prisma.roomBlock.count({ where: { locationId: lab.id, deletedAt: null } })) {
    console.log("DEMO-LAB-02 already has a layout — nothing to do.");
    return;
  }

  await rooms.create(user, { locationId: lab.id, roomType: "LAB" });

  const rowsA = Array.from({ length: 8 }, (_, i) => ({
    label: String(i + 1),
    seats: i === 7 ? [...pcs(2), { kind: "EMPTY_TABLE" as Kind }, { kind: "EMPTY_TABLE" as Kind }] : pcs(4),
  }));
  const rowsB = Array.from({ length: 8 }, (_, i) => ({
    label: String(i + 1),
    seats:
      i === 5
        ? Array.from({ length: 4 }, () => ({ kind: "EMPTY_TABLE" as Kind }))
        : i === 7
          ? [...pcs(2), { kind: "NO_TABLE" as Kind }]
          : pcs(4),
  }));

  const view = await rooms.applyLayout(user, lab.id, {
    expectedLayoutVersion: lab.layoutVersion,
    createWorkstations: true,
    generateEquipment: true,
    blocks: [
      { code: "T", name: "Instructor", rows: [{ label: "1", seats: [{ kind: "INSTRUCTOR" }] }] },
      { code: "A", name: "Window side", rows: rowsA },
      { code: "B", name: "Corridor side", rows: rowsB },
    ],
  });

  // Mock serial numbers on the generated PC parts.
  for (const ws of view.workstations) {
    for (const item of ws.equipment) {
      await prisma.equipment.update({
        where: { id: item.id },
        data: { brand: "DemoBrand", serialNo: `DEMO-${item.code}`, version: { increment: 1 } },
      });
    }
  }

  const types = new Map((await prisma.equipmentType.findMany()).map((t) => [t.code, t.id]));
  const fixtures = [
    { type: "AC", wall: "LEFT" },
    { type: "AC", wall: "RIGHT" },
    { type: "TV", wall: "FRONT" },
    { type: "WB", wall: "FRONT" },
    { type: "PRJ", wall: "CEILING" },
    { type: "FAN", wall: "CEILING" },
    { type: "RTR", wall: "BACK" },
    { type: "DOOR", wall: "BACK" },
  ] as const;
  for (const f of fixtures) {
    const typeId = types.get(f.type);
    if (typeId) await equipment.create(user, lab.id, { typeId, wall: f.wall, slot: 1, serialNo: `DEMO-${f.type}` });
  }

  console.log(`DEMO-LAB-02 set up: ${view.workstations.length} PCs. Mock data only.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
