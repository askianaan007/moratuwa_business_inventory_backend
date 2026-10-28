/**
 * Creates the first admin account, a demo department and locations, the
 * default item categories, and the default lab equipment types and fault reasons.
 * Safe to run more than once. Usage: npm run db:seed
 *
 * Needs SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in .env.
 */
import { prisma } from "../src/lib/prisma.js";
import { hashPassword, PASSWORD_RULES } from "../src/utils/password.js";

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL?.toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) throw new Error("Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in .env");
  if (password.length < PASSWORD_RULES.minLength || !PASSWORD_RULES.pattern.test(password)) {
    throw new Error(`SEED_ADMIN_PASSWORD is too weak. ${PASSWORD_RULES.message}`);
  }

  const department = await prisma.department.upsert({
    where: { code: "DEMO" },
    update: {},
    create: { code: "DEMO", name: "Demo Department" },
  });

  for (const location of [
    { code: "DEMO-LAB-01", name: "Laboratory 01", building: "Main Building", floor: "Ground" },
    { code: "DEMO-LAB-02", name: "Laboratory 02", building: "Main Building", floor: "1st" },
    { code: "DEMO-STORE", name: "Department Store", building: "Main Building", floor: "Ground" },
  ]) {
    await prisma.location.upsert({
      where: { departmentId_code: { departmentId: department.id, code: location.code } },
      update: {},
      create: { ...location, departmentId: department.id },
    });
  }

  for (const category of [
    { code: "COMP", name: "Computers" },
    { code: "MON", name: "Monitors" },
    { code: "MOUSE", name: "Mouses" },
    { code: "KBD", name: "Keyboards" },
    { code: "TBL", name: "Tables" },
    { code: "CHR", name: "Chairs" },
  ]) {
    await prisma.category.upsert({ where: { code: category.code }, update: {}, create: category });
  }

  await seedEquipmentTypes();

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`Admin ${email} already exists — password left unchanged.`);
  } else {
    await prisma.user.create({
      data: { name: "System Admin", email, role: "ADMIN", passwordHash: await hashPassword(password) },
    });
    console.log(`Created admin ${email}.`);
  }
  console.log("Seed complete.");
}

/** Lab audit equipment types (repot-v2 §3) and their quick-pick fault reasons. */
async function seedEquipmentTypes() {
  const categories = new Map((await prisma.category.findMany()).map((c) => [c.code, c.id]));
  const types = [
    { code: "MON", name: "Monitor", scope: "WORKSTATION", isPrimary: true, isDefault: true, maxPerWorkstation: 2, category: "MON", reasons: ["No display", "Flickering", "Dead pixels", "Cable damaged", "No power"] },
    { code: "CPU", name: "CPU / System unit", scope: "WORKSTATION", isDefault: true, category: "COMP", reasons: ["Not booting", "Very slow", "OS / software error", "No network", "Overheating"] },
    { code: "UPS", name: "UPS", scope: "WORKSTATION", isDefault: true, reasons: ["Battery dead", "Beeping", "No output"] },
    { code: "KBD", name: "Keyboard", scope: "WORKSTATION", isDefault: true, category: "KBD", reasons: ["Keys not working", "Keys missing", "Not detected"] },
    { code: "MSE", name: "Mouse", scope: "WORKSTATION", isDefault: true, category: "MOUSE", reasons: ["Not detected", "Scroll broken", "Buttons broken"] },
    { code: "AC", name: "Air conditioner", scope: "ROOM", reasons: ["Not cooling", "Water leaking", "Remote missing", "Noisy"] },
    { code: "TV", name: "Teaching monitor / Smart board", scope: "ROOM", reasons: ["No display", "No input signal", "Touch not working"] },
    { code: "PRJ", name: "Projector", scope: "ROOM", reasons: ["Lamp failure", "No signal", "Blurry image"] },
    { code: "FAN", name: "Ceiling fan", scope: "ROOM", reasons: ["Not rotating", "Noisy", "Regulator faulty"] },
    { code: "SPK", name: "Speakers", scope: "ROOM", reasons: ["No sound", "Distorted sound"] },
    { code: "RTR", name: "Network switch / Router", scope: "ROOM", reasons: ["No link lights", "Ports faulty", "No internet"] },
    { code: "WB", name: "Whiteboard", scope: "ROOM", reasons: ["Surface damaged", "Loose mounting"] },
    { code: "DOOR", name: "Door", scope: "ROOM", isAuditable: false, reasons: [] },
  ] as const;

  for (const [i, t] of types.entries()) {
    const data = {
      name: t.name,
      scope: t.scope,
      codePrefix: t.code,
      isPrimary: "isPrimary" in t ? t.isPrimary : false,
      isDefault: "isDefault" in t ? t.isDefault : false,
      isAuditable: "isAuditable" in t ? t.isAuditable : true,
      maxPerWorkstation: "maxPerWorkstation" in t ? t.maxPerWorkstation : 1,
      categoryId: "category" in t ? (categories.get(t.category) ?? null) : null,
      sortOrder: (i + 1) * 10,
    };
    const type = await prisma.equipmentType.upsert({ where: { code: t.code }, update: {}, create: { code: t.code, ...data } });
    if ((await prisma.faultReason.count({ where: { typeId: type.id } })) === 0) {
      await prisma.faultReason.createMany({
        data: t.reasons.map((label, j) => ({ typeId: type.id, label, group: "HARDWARE", sortOrder: (j + 1) * 10 })),
      });
    }
  }
  // Reasons that apply to any item.
  if ((await prisma.faultReason.count({ where: { typeId: null } })) === 0) {
    await prisma.faultReason.createMany({
      data: [
        { label: "Physically damaged", group: "PHYSICAL", sortOrder: 900 },
        { label: "Not found in room", group: "OTHER", sortOrder: 910 },
        { label: "Sent for repair", group: "OTHER", sortOrder: 920 },
        { label: "Room locked / no access", group: "OTHER", sortOrder: 930 },
        { label: "No power in room", group: "POWER", sortOrder: 940 },
      ],
    });
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
