/**
 * Creates the first admin account plus a demo department and locations.
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

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
