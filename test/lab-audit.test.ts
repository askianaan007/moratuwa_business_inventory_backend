/**
 * End-to-end tests of rooms, equipment and the monthly lab audit through the
 * HTTP API. Needs TEST_DATABASE_URL (migrated + `prisma/seed.ts` applied).
 * Every run creates its own department, users and room, so it can be repeated.
 */
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);

/** Collects a binary response body (supertest only buffers known text types by default). */
const binary = (res: NodeJS.ReadableStream & { setEncoding(e: string): void }, done: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => done(null, Buffer.concat(chunks)));
};
const PASSWORD = "Test-Passw0rd-123";

describe.skipIf(!enabled)("lab rooms & monthly audit (API)", async () => {
  const { createApp } = await import("../src/app.js");
  const { prisma } = await import("../src/lib/prisma.js");
  const { hashPassword } = await import("../src/utils/password.js");
  const app = createApp();

  const tag = randomUUID().slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, "X");
  type Agent = ReturnType<typeof request.agent>;
  const agents: Record<string, Agent> = {};
  let roomId = "";
  let auditId = "";
  let ledgerBefore = 0;
  let assetsBefore = 0;

  async function login(role: "ADMIN" | "HOD" | "TECHNICAL_OFFICER" | "VIEWER", departmentId: string | null, key: string) {
    const email = `${key}-${tag}@example.test`.toLowerCase();
    await prisma.user.create({ data: { name: `${key} ${tag}`, email, role, departmentId, passwordHash: await hashPassword(PASSWORD) } });
    const agent = request.agent(app);
    const res = await agent.post("/api/v1/auth/login").send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    agents[key] = agent;
    return agent;
  }

  const layout = (version: number, extra: object = {}) => ({
    expectedLayoutVersion: version,
    blocks: [
      {
        code: "A",
        name: "Window side",
        rows: Array.from({ length: 8 }, (_, i) => ({
          label: String(i + 1),
          seats: i === 7 ? [{ kind: "PC" }, { kind: "EMPTY_TABLE" }] : [{ kind: "PC" }, { kind: "PC" }],
        })),
      },
      {
        code: "B",
        name: "Corridor side",
        rows: Array.from({ length: 8 }, (_, i) => ({
          label: String(i + 1),
          seats: i === 2 ? [{ kind: "NO_TABLE" }, { kind: "PC" }] : [{ kind: "PC" }, { kind: "PC" }],
        })),
      },
    ],
    ...extra,
  });

  beforeAll(async () => {
    if ((await prisma.equipmentType.count()) === 0) throw new Error("Seed the test database first: tsx prisma/seed.ts");
    const dept = await prisma.department.create({ data: { code: `T${tag}`.slice(0, 10), name: `Test dept ${tag}` } });
    const other = await prisma.department.create({ data: { code: `O${tag}`.slice(0, 10), name: `Other dept ${tag}` } });
    await login("ADMIN", null, "admin");
    await login("HOD", dept.id, "hod");
    await login("TECHNICAL_OFFICER", dept.id, "to");
    await login("VIEWER", dept.id, "viewer");
    await login("TECHNICAL_OFFICER", other.id, "outsider");
    ledgerBefore = await prisma.ledgerEntry.count();
    assetsBefore = await prisma.assetItem.count();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("lets a HOD create a lab and save a layout with varying rows", async () => {
    const created = await agents.hod!.post("/api/v1/rooms").send({ code: `LAB-${tag}`, name: "Computer Lab Test", roomType: "LAB" });
    expect(created.status).toBe(201);
    roomId = created.body.data.id;

    const saved = await agents.hod!.post(`/api/v1/rooms/${roomId}/layout`).send(layout(0));
    expect(saved.status).toBe(200);
    const room = saved.body.data;
    expect(room.workstations).toHaveLength(15 + 15);
    expect(room.blocks[0].rows[7].seats[1].positionCode).toBe("A-R8-S2");
    // PCs are named after their monitor.
    expect(room.workstations[0].label).toBe("MON-01");
    expect(room.plan.desks).toHaveLength(32);
  });

  it("keeps technical officers and viewers out of layout changes", async () => {
    const res = await agents.to!.post(`/api/v1/rooms/${roomId}/layout`).send(layout(1));
    expect(res.status).toBe(403);
  });

  it("hides the room from other departments", async () => {
    const res = await agents.outsider!.get(`/api/v1/rooms/${roomId}`);
    expect(res.status).toBe(404);
  });

  it("rejects a stale layout version and refuses to remove a seat holding a PC", async () => {
    const stale = await agents.hod!.post(`/api/v1/rooms/${roomId}/layout`).send(layout(0));
    expect(stale.status).toBe(409);

    const room = (await agents.hod!.get(`/api/v1/rooms/${roomId}`)).body.data;
    const blocks = room.blocks.map((b: any) => ({
      id: b.id,
      code: b.code,
      name: b.name,
      rows: b.rows.map((r: any) => ({ id: r.id, label: r.label, seats: r.seats.map((s: any) => ({ id: s.id, kind: s.kind })) })),
    }));
    blocks[0].rows[0].seats.pop(); // A-R1-S2 holds a PC
    const preview = await agents.hod!.post(`/api/v1/rooms/${roomId}/layout/preview`).send({ expectedLayoutVersion: room.room.layoutVersion, blocks });
    expect(preview.status).toBe(200);
    expect(preview.body.data.blockers[0]).toMatch(/A-R1-S2/);
    const apply = await agents.hod!.post(`/api/v1/rooms/${roomId}/layout`).send({ expectedLayoutVersion: room.room.layoutVersion, blocks });
    expect(apply.status).toBe(409);
  });

  it("supports dual monitors, replacement that keeps the code, and history", async () => {
    const room = (await agents.to!.get(`/api/v1/rooms/${roomId}`)).body.data;
    const ws = room.workstations[0];
    const types = (await agents.to!.get("/api/v1/equipment-types")).body.data;
    const monitor = types.find((t: any) => t.code === "MON");

    const second = await agents.to!.post(`/api/v1/rooms/${roomId}/equipment`).send({ typeId: monitor.id, workstationId: ws.id, slot: 2 });
    expect(second.status).toBe(201);
    expect(second.body.data.code).toBe("MON-01-2");
    const third = await agents.to!.post(`/api/v1/rooms/${roomId}/equipment`).send({ typeId: monitor.id, workstationId: ws.id, slot: 3 });
    expect(third.status).toBe(400);

    const mon = ws.equipment.find((e: any) => e.type.code === "MON" && e.slot === 1);
    const replaced = await agents.to!.post(`/api/v1/equipment/${mon.id}/replace`).send({ expectedVersion: mon.version, reason: "Screen cracked", serialNo: "NEW-SERIAL" });
    expect(replaced.status).toBe(201);
    expect(replaced.body.data.code).toBe("MON-01");
    expect(replaced.body.data.id).not.toBe(mon.id);

    const again = await agents.to!.post(`/api/v1/equipment/${mon.id}/replace`).send({ expectedVersion: mon.version, reason: "twice" });
    expect(again.status).toBe(409); // old unit is retired now

    const history = await agents.to!.get(`/api/v1/equipment/${replaced.body.data.id}/history`);
    expect(history.body.data.older[0].id).toBe(mon.id);
    const after = (await agents.to!.get(`/api/v1/rooms/${roomId}`)).body.data;
    expect(after.workstations[0].label).toBe("MON-01");
    expect(after.workstations[0].id).toBe(ws.id);
  });

  it("adds room equipment", async () => {
    const types = (await agents.hod!.get("/api/v1/equipment-types")).body.data;
    for (const code of ["AC", "TV"]) {
      const res = await agents.hod!.post(`/api/v1/rooms/${roomId}/equipment`).send({ typeId: types.find((t: any) => t.code === code).id, wall: "FRONT" });
      expect(res.status).toBe(201);
    }
  });

  it("starts one audit per month, with one check per target", async () => {
    const forbidden = await agents.viewer!.post("/api/v1/lab-audits").send({ roomId, period: "2026-09", auditorName: "V", startedOn: "2026-09-28" });
    expect(forbidden.status).toBe(403);

    const res = await agents.to!.post("/api/v1/lab-audits").send({
      roomId,
      period: "2026-09",
      auditorName: "Test Officer",
      auditorDesignation: "Technical Officer",
      startedOn: "2026-09-28",
    });
    expect(res.status).toBe(201);
    auditId = res.body.data.id;
    const checks = res.body.data.checks;
    // 30 PCs × 5 parts + 1 extra monitor + 2 room items + 1 empty table
    expect(checks).toHaveLength(30 * 5 + 1 + 2 + 1);
    expect(new Set(checks.map((c: any) => c.targetKey)).size).toBe(checks.length);
    expect(checks.every((c: any) => c.status === "NOT_CHECKED")).toBe(true);

    const dup = await agents.to!.post("/api/v1/lab-audits").send({ roomId, period: "2026-09", auditorName: "Another", startedOn: "2026-09-28" });
    expect(dup.status).toBe(409);
  });

  it("freezes the layout while the audit is open", async () => {
    const room = (await agents.hod!.get(`/api/v1/rooms/${roomId}`)).body.data;
    const res = await agents.hod!.post(`/api/v1/rooms/${roomId}/layout`).send(layout(room.room.layoutVersion));
    expect(res.status).toBe(409);
  });

  it("records observations with reasons, idempotent retries and conflict detection", async () => {
    const audit = (await agents.to!.get(`/api/v1/lab-audits/${auditId}`)).body.data;
    const target = audit.checks.find((c: any) => c.typeCode === "CPU");

    const noReason = await agents.to!.patch(`/api/v1/lab-audits/${auditId}/checks`).send({
      changes: [{ checkId: target.id, expectedVersion: target.version, mutationId: randomUUID(), status: "NOT_WORKING" }],
    });
    expect(noReason.status).toBe(400);

    const mutationId = randomUUID();
    const change = { checkId: target.id, expectedVersion: target.version, mutationId, status: "NOT_WORKING", reasonText: "Not booting" };
    const ok = await agents.to!.patch(`/api/v1/lab-audits/${auditId}/checks`).send({ changes: [change] });
    expect(ok.status).toBe(200);
    expect(ok.body.data[0].version).toBe(target.version + 1);

    // Same request again (lost response): accepted, nothing changes.
    const retry = await agents.to!.patch(`/api/v1/lab-audits/${auditId}/checks`).send({ changes: [change] });
    expect(retry.status).toBe(200);
    expect(retry.body.data[0].version).toBe(target.version + 1);

    // Another device still holding the old version.
    const stale = await agents.hod!.patch(`/api/v1/lab-audits/${auditId}/checks`).send({
      changes: [{ ...change, mutationId: randomUUID(), status: "WORKING" }],
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details[0].path).toBe(target.id);
  });

  it("marks a whole PC working without overwriting faults", async () => {
    const audit = (await agents.to!.get(`/api/v1/lab-audits/${auditId}`)).body.data;
    const faulty = audit.checks.find((c: any) => c.status === "NOT_WORKING");
    const res = await agents.to!.post(`/api/v1/lab-audits/${auditId}/checks/bulk`).send({
      mutationId: randomUUID(),
      scope: { workstationId: faulty.workstationId },
      status: "WORKING",
    });
    expect(res.status).toBe(200);
    const onPc = audit.checks.filter((c: any) => c.workstationId === faulty.workstationId).length;
    expect(res.body.data.updated).toBe(onPc - 1);
    expect(res.body.data.checks.find((c: any) => c.id === faulty.id).status).toBe("NOT_WORKING");
  });

  it("refuses to submit with unexplained unchecked items, then submits", async () => {
    let audit = (await agents.to!.get(`/api/v1/lab-audits/${auditId}`)).body.data;
    const early = await agents.to!.post(`/api/v1/lab-audits/${auditId}/submit`).send({ expectedVersion: audit.version });
    expect(early.status).toBe(400);
    expect(early.body.error.code).toBe("AUDIT_INCOMPLETE");

    const rows = audit.blocks.flatMap((b: any) => b.rows);
    for (const row of rows) {
      const res = await agents.to!.post(`/api/v1/lab-audits/${auditId}/checks/bulk`).send({ mutationId: randomUUID(), scope: { rowId: row.id }, status: "WORKING" });
      expect(res.status).toBe(200);
    }
    audit = (await agents.to!.get(`/api/v1/lab-audits/${auditId}`)).body.data;
    const left = audit.checks.filter((c: any) => c.status === "NOT_CHECKED");
    expect(left.length).toBe(2); // the two room items
    await agents.to!.patch(`/api/v1/lab-audits/${auditId}/checks`).send({
      changes: left.map((c: any, i: number) => ({
        checkId: c.id,
        expectedVersion: c.version,
        mutationId: randomUUID(),
        status: i === 0 ? "WORKING" : "NOT_CHECKED",
        reasonText: i === 0 ? null : "Remote not available",
      })),
    });

    const submitted = await agents.to!.post(`/api/v1/lab-audits/${auditId}/submit`).send({ expectedVersion: audit.version });
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.status).toBe("SUBMITTED");
    expect(submitted.body.data.snapshots[0].revision).toBe(1);

    const locked = await agents.to!.patch(`/api/v1/lab-audits/${auditId}`).send({ expectedVersion: submitted.body.data.version, generalRemarks: "late edit" });
    expect(locked.status).toBe(423);
  });

  it("only lets someone who did not perform the audit approve it", async () => {
    const audit = (await agents.hod!.get(`/api/v1/lab-audits/${auditId}`)).body.data;
    const byTo = await agents.to!.post(`/api/v1/lab-audits/${auditId}/decision`).send({ expectedVersion: audit.version, decision: "APPROVED" });
    expect(byTo.status).toBe(403);
    // The HOD touched a check earlier only with a rejected (stale) write, so they did not inspect anything.
    const approved = await agents.hod!.post(`/api/v1/lab-audits/${auditId}/decision`).send({ expectedVersion: audit.version, decision: "APPROVED" });
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe("APPROVED");
    expect(approved.body.data.snapshots[0].revision).toBe(2);
  });

  it("renders deterministic A4 PDF and Word reports from the snapshot", async () => {
    const report = await agents.viewer!.get(`/api/v1/lab-audits/${auditId}/report`);
    expect(report.status).toBe(200);
    expect(report.body.meta.revision).toBe(2);
    expect(report.body.data.counts.byStatus.NOT_WORKING).toBe(1);
    expect(report.body.data.faults[0].reason).toBe("Not booting");

    const pdf1 = await agents.viewer!.get(`/api/v1/lab-audits/${auditId}/report.pdf`).buffer(true).parse(binary);
    const pdf2 = await agents.viewer!.get(`/api/v1/lab-audits/${auditId}/report.pdf`).buffer(true).parse(binary);
    expect(pdf1.status).toBe(200);
    const bytes = pdf1.body as Buffer;
    expect(bytes.subarray(0, 4).toString()).toBe("%PDF");
    expect(Buffer.compare(bytes, pdf2.body as Buffer)).toBe(0);
    const text = bytes.toString("latin1");
    expect(text).toMatch(/\/MediaBox \[0 0 595\.28\d* 841\.89\d*\]/);
    expect((text.match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThanOrEqual(2);

    const docx = await agents.viewer!.get(`/api/v1/lab-audits/${auditId}/report.docx`).buffer(true).parse(binary);
    expect(docx.status).toBe(200);
    expect((docx.body as Buffer).subarray(0, 2).toString()).toBe("PK");
  });

  it("never touched the ledger", async () => {
    expect(await prisma.ledgerEntry.count()).toBe(ledgerBefore);
    expect(await prisma.assetItem.count()).toBe(assetsBefore);
  });

  it("enforces one target per check in the database", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO lab_audit_checks (id, audit_id, target_kind, target_key, sort_key, type_code, type_name, item_code)
         VALUES ($1::uuid, $2::uuid, 'EQUIPMENT', 'E:bogus', 'z', 'X', 'X', 'X')`,
        randomUUID(),
        auditId,
      ),
    ).rejects.toThrow();
  });
});
