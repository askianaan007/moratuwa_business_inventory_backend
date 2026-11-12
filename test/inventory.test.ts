/**
 * Inventory tab API: register, finder, transfers, disposal, delete rules,
 * rooms and exports. Needs TEST_DATABASE_URL (migrated + seeded). Mock data only.
 */
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const PASSWORD = "Test-Passw0rd-123";
const binary = (res: NodeJS.ReadableStream & { setEncoding(e: string): void }, done: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => done(null, Buffer.concat(chunks)));
};

describe.skipIf(!enabled)("inventory (API)", async () => {
  const { createApp } = await import("../src/app.js");
  const { prisma } = await import("../src/lib/prisma.js");
  const { hashPassword } = await import("../src/utils/password.js");
  const app = createApp();
  const tag = randomUUID().slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, "X");
  const agents: Record<string, ReturnType<typeof request.agent>> = {};
  let deptId = "";
  let hallId = "";
  let storeId = "";
  let itemIds: string[] = [];
  let bulkId = "";

  async function login(role: "ADMIN" | "HOD" | "TECHNICAL_OFFICER" | "VIEWER", departmentId: string | null, key: string) {
    const email = `inv-${key}-${tag}@example.test`.toLowerCase();
    await prisma.user.create({ data: { name: `${key} ${tag}`, email, role, departmentId, passwordHash: await hashPassword(PASSWORD) } });
    const agent = request.agent(app);
    expect((await agent.post("/api/v1/auth/login").send({ email, password: PASSWORD })).status).toBe(200);
    agents[key] = agent;
  }

  beforeAll(async () => {
    const dept = await prisma.department.create({ data: { code: `I${tag}`.slice(0, 10), name: `Inventory dept ${tag}` } });
    const other = await prisma.department.create({ data: { code: `J${tag}`.slice(0, 10), name: `Other ${tag}` } });
    deptId = dept.id;
    await login("ADMIN", null, "admin");
    await login("HOD", dept.id, "hod");
    await login("TECHNICAL_OFFICER", dept.id, "to");
    await login("VIEWER", dept.id, "viewer");
    await login("TECHNICAL_OFFICER", other.id, "outsider");

    // Mock book entry: 3 projectors, plus a bulk line of 100 chairs.
    const entry = await prisma.ledgerEntry.create({
      data: { departmentId: dept.id, entryDate: new Date("2026-01-15"), description: "Projector (mock)", brand: "Acme", quantity: 3, unitPrice: 1000, value: 3000, bookVolume: "V1", bookPage: 42 },
    });
    itemIds = (
      await prisma.assetItem.createManyAndReturn({
        data: [1, 2, 3].map((n) => ({ ledgerEntryId: entry.id, tagCode: `MOCK-${tag}-${n}`, serialNo: n === 3 ? `SN-${tag}-1` : `SN-${tag}-${n}` })),
      })
    ).map((i) => i.id);
    const chairs = await prisma.ledgerEntry.create({
      data: { departmentId: dept.id, entryDate: new Date("2026-01-20"), description: "Chair (mock)", quantity: 100, unitPrice: 50, value: 5000 },
    });
    bulkId = (await prisma.assetItem.create({ data: { ledgerEntryId: chairs.id, tagCode: `MOCK-${tag}-CHR`, isBulk: true, bulkQty: 100 } })).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates rooms of any type, rejecting duplicate codes and bad input", async () => {
    const hall = await agents.hod!.post("/api/v1/inventory/rooms").send({ code: `LH-${tag}`, name: "Lecture Hall", roomType: "CLASSROOM", building: "Academic", floor: "1" });
    expect(hall.status).toBe(201);
    hallId = hall.body.data.id;
    const store = await agents.hod!.post("/api/v1/inventory/rooms").send({ code: `ST-${tag}`, name: "Store", roomType: "STORE" });
    storeId = store.body.data.id;

    const dup = await agents.hod!.post("/api/v1/inventory/rooms").send({ code: `LH-${tag}`, name: "Again" });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details[0].path).toBe("code");
    const bad = await agents.hod!.post("/api/v1/inventory/rooms").send({ code: "x", name: "" });
    expect(bad.status).toBe(400);
    expect((await agents.to!.post("/api/v1/inventory/rooms").send({ code: `NO-${tag}`, name: "Nope" })).status).toBe(403);
    expect((await agents.admin!.post("/api/v1/inventory/rooms").send({ code: `AD-${tag}`, name: "Admin room" })).status).toBe(400); // needs departmentId
  });

  it("lists and searches the register, including by book page and serial", async () => {
    const all = await agents.to!.get("/api/v1/inventory/assets").query({ q: `MOCK-${tag}` });
    expect(all.status).toBe(200);
    expect(all.body.meta.total).toBe(4);
    const byPage = await agents.to!.get("/api/v1/inventory/assets").query({ q: "42", departmentId: deptId });
    expect(byPage.body.data.every((i: { ledgerEntry: { bookPage: number } }) => i.ledgerEntry.bookPage === 42)).toBe(true);
    const bulk = await agents.to!.get("/api/v1/inventory/assets").query({ q: `MOCK-${tag}`, kind: "bulk" });
    expect(bulk.body.meta.total).toBe(1);
    expect((await agents.outsider!.get("/api/v1/inventory/assets").query({ q: `MOCK-${tag}` })).body.meta.total).toBe(0);
    expect((await agents.outsider!.get(`/api/v1/inventory/assets/${itemIds[0]}`)).status).toBe(404);
  });

  it("warns about duplicate serials and edits with an optimistic lock", async () => {
    const detail = await agents.to!.get(`/api/v1/inventory/assets/${itemIds[0]}`);
    expect(detail.body.data.warnings.join(" ")).toContain(`MOCK-${tag}-3`);
    const { updatedAt } = detail.body.data;

    const ok = await agents.to!.patch(`/api/v1/inventory/assets/${itemIds[0]}`).send({ expectedUpdatedAt: updatedAt, condition: "NEEDS_REPAIR", custodian: "Lab TO" });
    expect(ok.status).toBe(200);
    expect(ok.body.data.condition).toBe("NEEDS_REPAIR");
    const stale = await agents.to!.patch(`/api/v1/inventory/assets/${itemIds[0]}`).send({ expectedUpdatedAt: updatedAt, condition: "GOOD" });
    expect(stale.status).toBe(409);
    expect((await agents.to!.patch(`/api/v1/inventory/assets/${itemIds[0]}`).send({ expectedUpdatedAt: ok.body.data.updatedAt, status: "DISPOSED" })).status).toBe(400);
    expect((await agents.viewer!.patch(`/api/v1/inventory/assets/${itemIds[0]}`).send({ expectedUpdatedAt: updatedAt })).status).toBe(403);
  });

  it("transfers in bulk with history and status, and refuses foreign rooms", async () => {
    const moved = await agents.to!.post("/api/v1/inventory/transfers").send({ ids: [itemIds[1], itemIds[2], bulkId], toLocationId: storeId, type: "TO_STORE", reason: "End of semester" });
    expect(moved.status).toBe(200);
    expect(moved.body.data.moved).toBe(3);
    const item = await prisma.assetItem.findUniqueOrThrow({ where: { id: itemIds[1]! } });
    expect(item.status).toBe("IN_STORE");
    expect(await prisma.movement.count({ where: { assetItemId: itemIds[1]! } })).toBe(1);

    const again = await agents.to!.post("/api/v1/inventory/transfers").send({ ids: [itemIds[1]], toLocationId: storeId, reason: "Again" });
    expect(again.status).toBe(400);
    const noReason = await agents.to!.post("/api/v1/inventory/transfers").send({ ids: [itemIds[1]], toLocationId: hallId, reason: "" });
    expect(noReason.status).toBe(400);

    const foreign = await prisma.location.create({ data: { departmentId: (await prisma.department.findFirstOrThrow({ where: { code: `J${tag}`.slice(0, 10) } })).id, code: `F-${tag}`, name: "Foreign" } });
    expect((await agents.to!.post("/api/v1/inventory/transfers").send({ ids: [itemIds[1]], toLocationId: foreign.id, reason: "Nope" })).status).toBe(400);

    const log = await agents.to!.get("/api/v1/inventory/transfers").query({ locationId: storeId });
    expect(log.body.meta.total).toBe(3);
  });

  it("records a finding elsewhere without changing the registered room", async () => {
    const found = await agents.to!.post(`/api/v1/inventory/assets/${itemIds[1]}/findings`).send({ observedLocationId: hallId, note: "Seen during lecture" });
    expect(found.status).toBe(201);
    expect(found.body.data.result).toBe("FOUND_ELSEWHERE");
    expect((await prisma.assetItem.findUniqueOrThrow({ where: { id: itemIds[1]! } })).locationId).toBe(storeId);

    const findings = await agents.to!.get("/api/v1/inventory/findings");
    const mine = findings.body.data.find((f: { asset: { id: string } }) => f.asset.id === itemIds[1]);
    expect(mine.resolved).toBe(false);
    const detail = await agents.to!.get(`/api/v1/inventory/assets/${itemIds[1]}`);
    expect(detail.body.data.warnings.join(" ")).toContain(`LH-${tag}`);
  });

  it("only lets HOD/Admin dispose, and keeps disposed items searchable", async () => {
    const detail = await agents.to!.get(`/api/v1/inventory/assets/${itemIds[2]}`);
    expect((await agents.to!.post(`/api/v1/inventory/assets/${itemIds[2]}/dispose`).send({ expectedUpdatedAt: detail.body.data.updatedAt, reason: "Broken lamp" })).status).toBe(403);
    const done = await agents.hod!.post(`/api/v1/inventory/assets/${itemIds[2]}/dispose`).send({ expectedUpdatedAt: detail.body.data.updatedAt, reason: "Broken lamp", boardRef: "BOS-2026-1" });
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe("DISPOSED");
    expect((await agents.to!.get("/api/v1/inventory/assets").query({ q: `MOCK-${tag}-3` })).body.meta.total).toBe(0);
    expect((await agents.to!.get("/api/v1/inventory/assets").query({ q: `MOCK-${tag}-3`, includeDisposed: "true" })).body.meta.total).toBe(1);
    expect((await agents.to!.post("/api/v1/inventory/transfers").send({ ids: [itemIds[2]], toLocationId: hallId, reason: "Try" })).status).toBe(409);
  });

  it("deletes only history-free records, admin only", async () => {
    expect((await agents.hod!.delete(`/api/v1/inventory/assets/${itemIds[0]}`).send({ reason: "Typo" })).status).toBe(403);
    expect((await agents.admin!.delete(`/api/v1/inventory/assets/${itemIds[1]}`).send({ reason: "Typo" })).status).toBe(409); // has a transfer
    expect((await agents.admin!.delete(`/api/v1/inventory/assets/${itemIds[0]}`).send({ reason: "Entered twice" })).status).toBe(204);
    expect((await agents.to!.get(`/api/v1/inventory/assets/${itemIds[0]}`)).status).toBe(404);
  });

  it("summarises rooms and stock, and archives only empty rooms", async () => {
    const room = await agents.to!.get(`/api/v1/inventory/rooms/${storeId}`);
    expect(room.body.data.totals.units).toBe(101); // 1 projector + 100 chairs
    const summary = await agents.to!.get("/api/v1/inventory/summary");
    expect(summary.body.data.bulkUnits).toBeGreaterThanOrEqual(100);
    expect(summary.body.data.openFindings).toBeGreaterThanOrEqual(1);

    expect((await agents.hod!.delete(`/api/v1/inventory/rooms/${storeId}`)).status).toBe(409);
    expect((await agents.hod!.delete(`/api/v1/inventory/rooms/${hallId}`)).status).toBe(204);
    expect((await agents.to!.get(`/api/v1/inventory/rooms/${hallId}`)).status).toBe(404);
  });

  it("exports CSV and QR label PDFs", async () => {
    const csv = await agents.to!.get("/api/v1/inventory/assets.csv").query({ q: `MOCK-${tag}`, includeDisposed: "true" });
    expect(csv.status).toBe(200);
    expect(csv.text.split("\r\n").filter(Boolean)).toHaveLength(1 + 3);
    const pdf = await agents.to!.get("/api/v1/inventory/labels.pdf").query({ ids: [itemIds[1], bulkId].join(",") }).buffer(true).parse(binary);
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
  });
});
