# Monthly Lab Audit — Architecture Review & Revised Plan (v2)

Status: **plan only — nothing implemented.** Supersedes the design in `repot.md` (kept for comparison).
Backend: `moratuwa_backend` · Frontend: `moratuwa_frontend/src`

Legend: **[Fact]** verified in the repository · **[Rec]** recommendation · **[Assume]** must be proven in the M0 spike.

---

## 0. Verified facts from the repositories

| Area | Fact |
|---|---|
| Stack | Prisma **7.10.1** + `@prisma/adapter-pg`, Express 5, exported for Vercel's Express runtime (`src/app.ts`) and a `Dockerfile`. Next.js 16 with `cacheComponents: true`. |
| Roles | `ADMIN`, `HOD`, `TECHNICAL_OFFICER`, `VIEWER`; `authorize(...)` per route; `departmentScope` / `requireDepartment` / `assertInScope` (out-of-scope → **404**). |
| Conventions | Every write in `$transaction` + `logActivity(tx, …)`; soft delete via `deletedAt`; `AppError.conflict` (409) for locked states; P2002 → 409 automatically; responses `{ data }` / `{ data, meta }`. |
| Approval pattern | Ledger `DRAFT → SUBMITTED → APPROVED/REJECTED`, `Approval` row per decision; HOD cannot approve own entry (ADMIN can). |
| `Location` | department, code, name, building, floor, `deletedAt`. API has **list + create only** (no update/delete); create allowed for TO. Seed contains `DEMO-STORE` (not a lab). |
| `AssetItem` | tag code, serial, `locationId`, `condition`, `status`, `Movement` history. `AuditSession`/`AuditRecord` = yearly QR stock verification. |
| `Category` | Global (no department), seeded `COMP`, `MON`, `MOUSE`, `KBD`…; Admin-managed. |
| HTTP limits | **CORS methods: GET, POST, PATCH, DELETE only** (no PUT); frontend `api()` also has no PUT. JSON body limit **200 kb**. Rate limit **1000 req / 15 min / IP**. Backend CSP `default-src 'none'`. |
| Frontend shell | Bottom dock (Home, Ledger, Scan, Audit, Reports). `/audit`, `/reports` are `ComingSoon`. `(app)` layout wraps pages in `max-w-3xl` + navbar + dock. Patterns: `apiGet` inside `<Suspense>`, `api()` with field errors, daisyUI tabs/badges, localStorage in try/catch. User menu links only to Categories. |
| Session | `api()` refreshes once on 401; if refresh fails it does a **full page reload** to `/login` (in-memory state lost). |
| Reports / offline | **No** PDF, DOCX, Excel, Dexie or service-worker libraries installed. `PLAN.md` lists pdfmake, ExcelJS, Dexie as planned. |
| Tests | **No test framework in either repo** (no vitest/jest/supertest/playwright). |
| Prisma partial indexes | No support found in the installed 7.10.1. |

---

## 1. Review of `repot.md`

**Strengths:** reuses `Location`; keeps monthly audit separate from stock verification; equipment types as a table; layout snapshot idea; copy-last-month; one SVG plan for all contexts.

**Problems found:**

| # | Issue in `repot.md` | Consequence |
|---|---|---|
| 1 | `PUT /rooms/:id/layout` | Blocked by CORS and unsupported by `api()`. |
| 2 | `LabAuditCheck @@unique([auditId, componentId])` + `@@unique([auditId, fixtureId])` | NULLs are distinct in Postgres → fixture rows and seat rows are **not** de-duplicated; nothing enforces exactly one target. |
| 3 | `Component @@unique([workstationId, typeId])` | Blocks dual monitors; forces deleting/reusing rows on replacement → history lost. |
| 4 | Separate `Component` and `RoomFixture` | Two nullable target FKs in checks; replace/move/link logic duplicated. |
| 5 | `Location.roomType @default(LAB)` | Existing store/office locations would appear as labs. |
| 6 | `rows Int` + `seatsPerRow` only | Cannot vary seat counts, label, reorder or rename individual rows. |
| 7 | Snapshot only at audit start | Approved report not reproducible (statuses, reasons, auditor, settings not frozen at submission). |
| 8 | Approval optionally updates `AssetItem` | Silently alters official inventory. |
| 9 | Autosave per tap + "offline queue" in polish | Rate-limit risk on shared campus IP; implies offline support that does not exist. |
| 10 | Print route inside `(app)/audit/...` | Prints navbar and dock. |
| 11 | Browser print page numbers / Puppeteer on Vercel | `counter(pages)` margin boxes are Chromium-only (no Safari/iOS); Chromium is heavy on serverless. |
| 12 | `reasons String[]` | Renaming a reason breaks month-to-month statistics and old reports. |
| 13 | `period String`, no version / idempotency fields | Concurrent edits and retries undetectable. |
| 14 | Testing checklist | No test framework exists to run it. |

---

## 2. Position naming (find any equipment from the report)

**[Rec]**

- **Block** has a short `code` + `name`: `A` "Window side", `B` "Corridor side".
- **Row** has a `label` (default `1…n`, row 1 nearest the board).
- **Seat** numbered `1…n` from the left **when facing the board**. The plan always draws the board at the top.
- **Position code** = `A-R3-S2`, displayed "Block A · Row 3 · Seat 2". Shown on every screen, report row and search result; searching `MON-07` highlights its desk.
- Position codes are **derived** from the current layout and **frozen into each audit check**, so reordering rows later never changes old reports.
- Equipment codes (`MON-07`) do **not** embed position (equipment moves, positions get renamed). PC number and monitor code are stable; position code says where it is now.

---

## 3. Revised data model

All changes are **additive** (new tables/columns with defaults). Nothing existing is dropped, renamed or retyped.

```
Department ──┬── Location (+ roomType, layoutVersion)
             │      ├── RoomBlock (code A/B, name, order)
             │      │      └── RoomRow (label, order)
             │      │             └── Seat (order, kind: PC | EMPTY_TABLE | NO_TABLE | INSTRUCTOR)
             │      ├── Workstation (stable id, number; seatId nullable → can be moved/stored)
             │      └── Equipment (one table for PC parts AND room fixtures)
             │             ├─ workstationId? (null = room fixture: AC, TV, projector, door…)
             │             ├─ assetItemId?  → existing AssetItem (read-only link)
             │             └─ replacesId?   → previous Equipment (replacement chain)
             ├── ReportSettings (1:1)
             └── LabAudit (location, period)
                    ├── LabAuditCheck      (one per target: Equipment OR Seat)
                    ├── LabAuditTransition (start/submit/return/approve/reopen history)
                    └── LabAuditSnapshot   (frozen report data per submission/approval)
EquipmentType (global, like Category; optional categoryId) ── FaultReason
```

### 3.1 Prisma sketch

```prisma
enum RoomType        { LAB  CLASSROOM  STORE  OFFICE  OTHER }   // existing rows → OTHER
enum SeatKind        { PC  EMPTY_TABLE  NO_TABLE  INSTRUCTOR }
enum EquipmentScope  { WORKSTATION  ROOM  BOTH }
enum EquipmentState  { IN_SERVICE  AT_REPAIR  RETIRED }
enum LabCheckStatus  { WORKING  NOT_WORKING  NEEDS_REPAIR  MISSING  REMOVED  NOT_CHECKED }
enum LabAuditStatus  { DRAFT  SUBMITTED  RETURNED  APPROVED }
enum CheckTargetKind { EQUIPMENT  SEAT }

model Location {            // existing — additive columns only
  roomType      RoomType @default(OTHER) @map("room_type")
  layoutVersion Int      @default(0)     @map("layout_version")  // optimistic lock for layout edits
}

model RoomBlock { id; locationId; code String; name String; order Int; deletedAt? }
model RoomRow   { id; blockId; label String; order Int; deletedAt? }
model Seat      { id; rowId; order Int; kind SeatKind; note String?; deletedAt? }

model Workstation {
  id; departmentId; locationId; seatId String?; number Int; labelOverride String?
  activeSeatKey   String? @unique   // "<seatId>" while placed, null when unplaced/retired
  activeNumberKey String? @unique   // "<locationId>:<number>" while not retired
  version Int @default(0); deletedAt?
}

model EquipmentType {
  id; code @unique; name; scope EquipmentScope; codePrefix String  // "MON"
  isPrimary Boolean            // names the PC (Monitor)
  isDefault Boolean            // added to new PCs
  isAuditable Boolean @default(true)   // Door = false
  maxPerWorkstation Int @default(1)    // Monitor = 2 allows dual screens
  categoryId String?           // ledger Category, validates asset links
  sortOrder Int; isActive Boolean
}
model FaultReason { id; typeId String?; label; group String; sortOrder; isActive }  // never deleted

model Equipment {
  id; departmentId; locationId; workstationId String?; typeId; slot Int @default(1)
  code String; number Int; brand?; modelNo?; serialNo?; assetItemId String?
  state EquipmentState @default(IN_SERVICE); replacesId String?
  wall String?; x Float?; y Float?            // fixtures only (0–100 % of plan)
  installedAt DateTime; retiredAt DateTime?; retiredReason String?
  activeCodeKey  String? @unique  // "<locationId>:<CODE>"              null once RETIRED
  activeSlotKey  String? @unique  // "<workstationId>:<typeId>:<slot>"  null when not at a PC
  activeAssetKey String? @unique  // "<assetItemId>"                    null once RETIRED
  version Int @default(0)
}

model LabAudit {
  id; departmentId; locationId; period DateTime @db.Date   // first day of month
  reference String @unique        // LA-<LOCATIONCODE>-2026-10
  auditorName; auditorDesignation?; startedOn @db.Date; completedOn? @db.Date
  status LabAuditStatus @default(DRAFT); generalRemarks?; recommendations?
  layoutVersionAtStart Int; copiedFromAuditId String?
  createdById; version Int @default(0); createdAt; updatedAt
  @@unique([locationId, period])
}

model LabAuditCheck {
  id; auditId; targetKind CheckTargetKind; equipmentId String?; seatId String?
  targetKey String                 // "E:<equipmentId>" | "S:<seatId>"
  // frozen at creation:
  positionCode String?; stationLabel String?; typeCode; typeName; itemCode; serialNo?; assetTag?
  status LabCheckStatus @default(NOT_CHECKED)
  faultReasonId String?; reasonText String?; notes String?; actionTaken String?; followUp String?
  suggestedStatus LabCheckStatus?; suggestedReason String?   // from previous approved audit; never counted
  addedAfterStart Boolean @default(false); targetRetiredAfterStart Boolean @default(false)
  checkedAt?; checkedById?; lastMutationId String?; version Int @default(0)
  @@unique([auditId, targetKey])
}

model LabAuditTransition { id; auditId; from LabAuditStatus?; to LabAuditStatus; actorId; comment?; at }
model LabAuditSnapshot   { id; auditId; revision Int; kind String; data Json; sha256 String; createdById; createdAt
                           @@unique([auditId, revision]) }
model ReportSettings     { departmentId @id; institution; faculty?; departmentTitle; hodName?; hodDesignation?;
                           checkedByLabel?; footerNote?; version Int }
```

### 3.2 Design rationale

- **One `Equipment` table** — a monitor and an AC are both physical items in a room; checks have only two target kinds (equipment, seat).
- **Nullable "active key" columns instead of partial indexes** — no partial-index support was found in Prisma 7.10.1. A nullable `@unique` column (multiple NULLs allowed in Postgres) enforces "one *active* MON-07 per room" and "one monitor in slot 1 of PC 7" while retired rows keep their history. Fully expressible in Prisma, so no migration drift.
- **Check targets** — `@@unique([auditId, targetKey])` guarantees each target exactly once per audit. A raw-SQL `CHECK` in the migration enforces exactly one FK: `(target_kind='EQUIPMENT' AND equipment_id IS NOT NULL AND seat_id IS NULL) OR (target_kind='SEAT' AND seat_id IS NOT NULL AND equipment_id IS NULL)`. **[Assume]** Prisma does not diff CHECK constraints, so it survives later `migrate dev` — prove in M0.
- **Replacement never reuses a row** — the old item becomes `RETIRED` (or `AT_REPAIR`, which frees the slot); a new row is created with `replacesId`. By default the replacement **keeps code `MON-07`** (same sticker on the desk), possible because the old row's `activeCodeKey` is now null.
- **Workstation identity** — `id` and `number` never change. Display label = `labelOverride` → else code of the active primary equipment in slot 1 (monitor) → else `PC-07`.
- **Numbering** — default equipment number = PC number (MON-07, CPU-07, UPS-07 all belong to PC 7). Codes upper-case, zero-padded to 2 digits (3 if > 99 PCs). Renumbering is an explicit Admin/HOD action with preview + activity log; past reports are unaffected (frozen).
- **Ledger link** — asset must be in the same department and not `DISPOSED`; warn if the asset's ledger category differs from `EquipmentType.categoryId`. Linking never modifies `AssetItem`.
- **Existing locations** default to `roomType = OTHER`; only rooms with a configured layout appear in the Rooms tab.

---

## 4. API contract

Follows existing conventions: `{ data }`, Zod validation, 404 out of scope, 409 on conflict, **POST/PATCH/DELETE only**.

### Rooms & equipment

| Method & path | Roles | Notes |
|---|---|---|
| `GET /rooms?roomType` | any | Configured rooms with PC count, last audit, this month's status |
| `POST /rooms` | Admin, HOD | Create a Location, or convert an existing `locationId` into a room |
| `GET /rooms/:id` | any | Blocks → rows → seats, workstations, equipment, `layoutVersion`, **computed plan geometry** |
| `PATCH /rooms/:id` | Admin, HOD | Room details (fills the missing Location update) |
| `POST /rooms/:id/layout/preview` | Admin, HOD | Full layout tree (ids for existing nodes) → diff: seats added/removed/changed, equipment affected, PCs left unplaced |
| `POST /rooms/:id/layout` | Admin, HOD | Same body + `expectedLayoutVersion`. One transaction; version bump guarded by `WHERE layout_version = v` → 409. Refuses to remove a seat holding an active workstation (move it first). Refuses structural changes while a DRAFT/RETURNED audit exists |
| `POST /rooms/:id/equipment/generate` (`?dryRun`) | Admin, HOD | Create default equipment for PCs that lack it |
| `POST /rooms/:id/equipment` · `PATCH /equipment/:id` | Admin, HOD, TO | `expectedVersion` required |
| `POST /equipment/:id/replace` · `/move` · `/repair` · `/retire` · `/link-asset` · `/unlink-asset` | Admin, HOD, TO | All logged; reason required |
| `GET /equipment/:id/history` | any | Replacement chain, moves, audit results |
| `POST /rooms/:id/renumber/preview` · `/renumber` | Admin, HOD | |
| `GET/POST/PATCH /equipment-types`, `/fault-reasons` | read any; write Admin | Same pattern as categories |

### Lab audits & reports

| Method & path | Roles | Notes |
|---|---|---|
| `GET /lab-audits?roomId&period&status&page` | any | |
| `POST /lab-audits` | Admin, HOD, TO | `{ roomId, period:"2026-10", auditorName, auditorDesignation, startedOn, copyFromPrevious }`. Creates all checks in one transaction; duplicate month → 409 |
| `GET /lab-audits/:id` | any | Audit + checks + summary + `version` |
| `PATCH /lab-audits/:id` | Admin, HOD, TO | Header fields; DRAFT/RETURNED only; `expectedVersion` |
| `PATCH /lab-audits/:id/checks` | Admin, HOD, TO | `{ changes:[{checkId, expectedVersion, mutationId, status, faultReasonId, reasonText, notes, actionTaken, followUp}] }`, max 50; all-or-nothing; conflict → 409 with current rows |
| `POST /lab-audits/:id/checks/bulk` | Admin, HOD, TO | `{ scope:{workstationId}|{rowId}, status:"WORKING", onlyUnchecked:true, mutationId }` |
| `POST /lab-audits/:id/targets/preview` · `/targets/sync` | Admin, HOD, TO | Add equipment installed after start; flag retired targets |
| `POST /lab-audits/:id/submit` | Admin, HOD, TO | Validate → snapshot + transition |
| `POST /lab-audits/:id/decision` | Admin, HOD | `APPROVED` / `RETURNED` + comment; not by whoever created/performed it |
| `POST /lab-audits/:id/reopen` | Admin | Reason required; new revision; old snapshots kept |
| `GET /lab-audits/:id/report?snapshot=` | any | Report JSON model |
| `GET /lab-audits/:id/report.pdf` · `.docx` `?snapshot=` | any | Binary download through the existing Next rewrite |
| `GET /lab-audits/:id/discrepancies` | any | Read-only ledger comparison |
| `GET/PATCH /report-settings` | read any; write Admin, HOD (own dept) | |

**Idempotency** — a retry whose `mutationId` already equals the check's `lastMutationId` returns the current row as success (lost-response case). Status transitions use guarded `updateMany where status=… and version=…`; 0 rows → 409, so double-tapping Submit cannot submit twice.

**New backend modules** — `src/modules/rooms/`, `src/modules/equipment/`, `src/modules/lab-audits/` (with `lab-audit-report.ts`), `src/modules/reports/` (pdf/docx renderers), each `*.routes → *.controller → *.service` + `*.schema.ts`. `src/modules/rooms/plan-geometry.ts` is a pure function and the **single source** of plan coordinates for screen, PDF and DOCX.

---

## 5. Frontend routes & components

**Navigation [Rec]** — keep the 5-tab dock unchanged. **Audit** becomes a hub with `tabs tabs-box` (same pattern as the ledger page): **This month · Rooms · Stock verification** (existing placeholder). **Reports** lists lab-audit reports. User menu gains *Rooms*, *Equipment types*, *Report settings* beside Categories.

```
src/app/(app)/audit/layout.tsx                      tabs
src/app/(app)/audit/page.tsx                        this month: room cards (Not started / Draft 64% / Submitted / Approved)
src/app/(app)/audit/rooms/page.tsx | new/page.tsx
src/app/(app)/audit/rooms/[roomId]/page.tsx         top view + equipment list + search
src/app/(app)/audit/rooms/[roomId]/layout-editor/page.tsx
src/app/(app)/audit/rooms/[roomId]/equipment/page.tsx
src/app/(app)/audit/runs/[auditId]/page.tsx         audit execution
src/app/(app)/audit/runs/[auditId]/review/page.tsx  summary, submit, approve/return, history
src/app/(app)/reports/page.tsx                      replace placeholder
src/app/(app)/settings/equipment-types/page.tsx | report/page.tsx
src/app/print/lab-audits/[auditId]/page.tsx         OUTSIDE (app): no navbar/dock; on-screen preview
src/components/room/room-plan.tsx                   pure SVG from geometry (server-renderable)
src/components/room/room-plan-viewer.tsx            client: zoom, pan, select, highlight
src/components/room/detail-sheet.tsx                daisyUI modal-bottom
src/components/room/layout-editor.tsx
src/components/audit/check-controls.tsx | save-indicator.tsx | progress.tsx
src/lib/lab-status.ts                               label + colour + symbol per status
src/lib/audit-outbox.ts                             pending-change queue
```

Also updates `src/lib/types.ts`, `src/lib/format.ts`, `src/components/user-menu.tsx`, `src/components/icons.tsx`. All pages follow the `apiGet`-inside-`<Suspense>` pattern required by `cacheComponents`. Read the relevant guides in `node_modules/next/dist/docs/` before writing code (AGENTS.md).

### Top view

- Geometry comes from the backend; the frontend only draws.
- Board at the top; door is a non-auditable fixture; aisles between blocks.
- Desks show position code + monitor label.
- Status = colour **and** symbol: ✓ Working · ✗ Not working · ⚠ Needs repair · ? Missing · ⊘ Removed · ○ Not checked. Empty table = dashed outline. Gap = nothing drawn.
- Detail sheet opens on tapping a desk or fixture.

### Phone strategy

16+ desks cannot fit at 44 px tap size on a 360 px screen, so:

- The plan is an **overview / navigator** (Fit mode, +/− zoom, horizontal pan; tapping a block header zooms into that block).
- Actual inspection happens in a **list grouped Block → Row**, with **Prev PC / Next PC** buttons inside the detail sheet.
- The `max-w-3xl` container stays; the SVG scales; the desktop table view scrolls horizontally.

---

## 6. Monthly audit workflow

1. **Start** — choose room + month. Auditor name defaults to the signed-in user, designation to the last one used; choose start date and whether to copy last month. One transaction creates a check for every active auditable equipment item and every `EMPTY_TABLE` / `INSTRUCTOR` seat without a PC (gaps get none), each with frozen position, codes and serial.
2. **Inspect** — tap a PC → sheet → tap a status. Any non-working status opens reason chips + notes + action taken + follow-up. **"All working for this PC"** affects only unchecked items; if others already have a status, a confirm shows the count. Row-level bulk works the same way. **No room-wide bulk.**
3. **Copy last month** — fills `suggestedStatus` / `suggestedReason`, shown as a faded hint. The check stays **Not checked** until the auditor confirms with one tap. Reports never count suggestions.
4. **Mid-audit changes** — banner "2 items added since start — include?" → sync adds checks with `addedAfterStart`. Retired targets are flagged; their check is kept.
5. **Submit** — server validates: every non-working check has a reason; Missing has a note; Removed has a reason/reference; Not checked has a reason (e.g. "room locked", see decision 6); `startedOn ≤ completedOn ≤ today`. Then snapshot + transition; audit becomes read-only.
6. **HOD review** — approve, or return with a comment. Returned audits are editable and resubmit as a new snapshot revision. Approved = locked; only an Admin reopen with a reason undoes it.

### Status meanings

| Status | Equipment check | Seat check (empty table / instructor desk) | Requirement |
|---|---|---|---|
| Working | Inspected, functions normally | Table present and usable | — |
| Needs repair | Works but defective | Table damaged | Reason |
| Not working | Does not function | — | Reason |
| Missing | Expected but not found, no authorised removal | Table missing | Reason + note; listed as discrepancy |
| Removed | Absent for a known reason (repair, transfer) | — | Reason / reference; pre-suggested when equipment is `AT_REPAIR` |
| Not checked | Default; **never counts as working** | Default | Reason required at submit; lowers completion % |

### Distinguishing "absent" cases

- **Gap** (`NO_TABLE`) — nothing to audit, no check.
- **Empty table** — a seat check confirming the table is present and usable.
- **Missing expected workstation** — a PC seat whose components are all Missing; the report shows "Workstation missing at A-R3-S2", not five separate faults.
- **Intentionally removed component** — `REMOVED` with a reason/reference (e.g. "Sent to IT, job #123").
- **Never installed** — no equipment record, so no check. Reported as a **configuration gap** (e.g. "PCs without a UPS registered: A-R2-S4, B-R7-S1"), not as a fault.

### Progress & recovery

- Header shows `checked / total` and per-block percentages.
- Every saved change is on the server, so reopening the audit on any device continues where it stopped.
- "This month" tab lists unfinished drafts first.

---

## 7. Official report

### 7.1 Contents (A4 portrait)

1. **Header** — institution, faculty, department (from `ReportSettings`); room name, code, building, floor; reference `LA-…-2026-10`; reporting month.
2. **Audit details** — auditor name + designation; start and completion dates; submitted / approved dates; snapshot revision.
3. **Summary** — seats, PCs, empty tables, fixtures; checked / not checked / working / not working / needs repair / missing / removed; **completion %**; per-type breakdown (types × statuses).
4. **Key findings** — top faults, PCs fully down, items faulty ≥ 2 consecutive months, missing items.
5. **Top-view plan** with legend (symbols + colour).
6. **Fault register** — position, PC, item code, type, status, reason, action taken, follow-up, months outstanding.
7. **Full workstation register** — No · Position · PC label · one column per type (MON, CPU, UPS, KBD, MSE, extras) · Remarks.
8. **Room equipment** — AC, teaching monitor, projector…
9. **Comparison with previous approved audit** — new faults, fixed, still faulty.
10. **Configuration gaps** and **ledger discrepancies** (information only).
11. **Remarks & recommendations.**
12. **Signatures** — Prepared by (auditor) · Checked by · **Head of Department** — name, signature line, date. If approved in the app: "Approved in system by … on …".
13. **Footer on every page** — reference · "Generated <snapshot time>" · `Page x of y`.

### 7.2 Generation options

| Option | Page x of y | Vercel + Docker | Deterministic | Verdict |
|---|---|---|---|---|
| Browser print (CSS `@page`) | Chromium only (margin boxes); not Safari/iOS | Yes | Browser-dependent | **Preview only** |
| Puppeteer / Playwright (headless Chromium) | Yes | Heavy on serverless; fine in campus Docker | Yes | **Later**, on the campus server |
| **pdfmake** (backend; already listed in `PLAN.md`) | Yes (built-in page counter) | Yes, pure JS | Yes, with fixed creation date | **First release** |
| **`docx`** (backend) | Yes (Word PAGE / NUMPAGES fields) | Yes, pure JS | Yes | **First release** (editable Word) |

**[Rec]** Both files are rendered **only from `LabAuditSnapshot.data`**, never from live tables. The snapshot timestamp is the generation time, so the same revision always produces the same file.

**[Assume]** pdfmake renders the plan via its SVG support. For DOCX, verify in M0 whether the `docx` library can embed SVG with a PNG fallback, or whether `@resvg/resvg-wasm` is needed to rasterise it, and that it runs on Vercel.

### 7.3 Layout rules

- **Page:** A4 210 × 297 mm; margins 15 mm sides and top, 18 mm bottom (footer).
- **Fonts:** Roboto (pdfmake built-in) / Calibri in Word; tables 9–10 pt; plan labels never below 7 pt.
- **Tables:** header rows repeat on every page (pdfmake `headerRows`, Word "repeat header row"); rows never split across pages.
- **Wide registers:** more than 9 status columns → landscape section.
- **Plan:** full page width, up to ~120 mm tall; denser layouts get their own page.
- **Signatures:** kept together with the final remarks so the block never stands alone on the last page.
- **Grayscale:** every status has a symbol and pattern.

### 7.4 Verification

- Automated tests against a fixture snapshot: page size 595.28 × 841.89 pt, expected page count, extracted text (reference, totals, signature labels), byte-identical output on repeat generation.
- DOCX: unzip and assert `w:pgSz` (11906 × 16838 twips), margins, PAGE/NUMPAGES fields present.
- Manual: open in Word and LibreOffice; print one in grayscale on a real A4 printer before the pilot.

---

## 8. Security, data integrity & offline resilience

### Permissions (enforced in the backend)

| Action | Admin | HOD | TO | Viewer |
|---|---|---|---|---|
| Create rooms, edit layouts, renumber | ✅ | ✅ own dept | ✗ | ✗ |
| Add / edit / replace / move / retire equipment | ✅ | ✅ | ✅ | ✗ |
| Equipment types, fault reasons | ✅ | ✗ | ✗ | ✗ |
| Report settings | ✅ | ✅ own dept | ✗ | ✗ |
| Start, fill, submit audits | ✅ | ✅ | ✅ | ✗ |
| Approve / return | ✅ (not own) | ✅ (not own) | ✗ | ✗ |
| Reopen approved audit | ✅ | ✗ | ✗ | ✗ |
| View rooms, history, download reports | ✅ | ✅ | ✅ | ✅ |

- Every new table carries `departmentId` (audits inherit it from the room); every service uses `departmentScope` / `assertInScope` → other departments get 404.
- Nobody approves an audit they created or performed.

### Protecting submitted / approved audits

- Edits allowed only in DRAFT / RETURNED; otherwise 423/409.
- Snapshots and transitions are append-only.
- Every write calls `logActivity`.

### Concurrency

- Layout guarded by `Location.layoutVersion`.
- `version` on audits and on each check; every update sends its expected version.
- On 409 the UI shows "Changed by <user> at <time>" with their value and a choice: keep theirs / apply mine. Never silently overwritten.
- Retries made safe by `mutationId` (section 4).

### Layout changes vs audits

- **Open audit (DRAFT/RETURNED):** structural layout changes are refused; equipment changes are allowed and brought in by explicit target sync.
- **Submitted / approved audits:** unaffected — reports come from the frozen snapshot.

### Keeping the ledger separate

- First release **never writes** to `ledger_entries` or `asset_items`.
- Differences go to a read-only discrepancy list: linked asset recorded in another location; observed Not working while ledger says GOOD; Missing items.
- **Later:** "Apply to inventory" — HOD/Admin, per item, only on approved audits; updates `condition`/`status` only (never quantity or value); location fixes go through the existing `items.move`; each change logged with the audit reference.
- The handwritten ledger book is unaffected.

### Offline — honest scope for the first release

- No service worker or IndexedDB exists, so the first release is **online-first with retries. It is not offline auditing and will not be described as such.**
- Pending changes are kept in an in-memory queue mirrored to localStorage (in try/catch), each with `mutationId` + expected version.
- The queue is written to storage **before each send**, because `api()` does a full reload when a session refresh fails.
- Indicator: *Saved* · *Saving* · *N unsaved — retrying* · *Conflict* · *Storage unavailable — keep this tab open*.
- Changes are batched (≈ 1.5 s debounce, about one request per PC), well under 1000 req / 15 min even when the whole lab shares one campus IP.
- After a refresh, queued changes are replayed; version mismatches surface as conflicts.
- Start, submit and approve require a connection.
- Real offline (service worker + IndexedDB + pre-downloaded targets) is a later milestone with its own tests.

### Data handling

- Development and tests use mock data only (separate seed script, `DEMO` department, invented codes and serials).
- `PLAN.md` mentions free cloud hosting (Vercel + Neon). **Do not put real university inventory there without approval** — run the pilot on local Postgres or the campus server.

---

## 9. Milestones

| # | Milestone | Backend | Frontend | Database | Tests & acceptance | Risks |
|---|---|---|---|---|---|---|
| **M0** | Spike + test harness *(needs package approval)* | vitest + supertest + test DB; prove CHECK constraint, active-key pattern, pdfmake SVG, docx on Vercel | — | Throwaway DB only | All [Assume] items pass or are replaced | Prisma drift; serverless limits |
| **M1** | Schema | `schema.prisma` models; one **additive** migration with raw-SQL CHECKs; `prisma/seed-lab-demo.ts` | `lib/types.ts` | New tables/columns with defaults; existing locations → `OTHER` | Migration runs on a copy; ledger and items screens unchanged | Default for existing locations |
| **M2** | Rooms & layout API | `modules/rooms`, `plan-geometry.ts`, preview/apply, Location update; register in `routes.ts` | — | — | 2 blocks × 8 rows with varying seats; version conflict; refusal during open audit; cross-dept 404 | Layout diff logic |
| **M3** | Room UI | — | Audit tabs layout, room list, plan viewer, layout editor, user-menu links | — | Works at 360 px, tablet, desktop; preview equals saved result | Phone usability |
| **M4** | Equipment identity | `modules/equipment`, types, fault reasons, generate/replace/move/repair/retire/renumber/link, history | Equipment page, types settings | — | Dual monitor allowed; replacement keeps MON-07 and old row; one active code per room; rejects other-dept / disposed asset links | Asset-link edge cases |
| **M5** | Audit lifecycle API | `modules/lab-audits`: start, checks, bulk, suggestions, sync, submit, decision, reopen, transitions, snapshots | — | — | Exactly one check per target; retry no duplicates; concurrent edit → 409; submit validation; approved locked; no self-approval | Transaction size for large rooms |
| **M6** | Phone audit UI | — | Run screen, detail sheet, Prev/Next, bulk confirm, outbox, save indicator, review page | — | 16-PC audit < 10 min on a phone; refresh mid-audit keeps changes; two devices → conflict prompt | Session expiry mid-audit |
| **M7** | Reports | `lab-audit-report.ts`, `modules/reports` (pdf, docx), report settings | Reports tab, `/print/...` preview | — | Section 7.4 checks pass; deterministic; grayscale readable | Pagination edge cases |
| **M8** | Hardening + pilot | Permission matrix tests across all endpoints; discrepancy list | Accessibility pass, dark mode | — | One real month audited and accepted by the HOD | — |
| Later | — | Apply-to-inventory, Excel export, server PDF via Chromium on campus, real offline, QR scanning, photo evidence, analytics | | | | |

### Files likely to change

- **Backend (existing):** `prisma/schema.prisma`, new `prisma/migrations/<ts>_lab_rooms_and_audits/`, `src/routes.ts`, `package.json` (after approval), `README.md`.
- **Backend (new):** `src/modules/rooms/*`, `src/modules/equipment/*`, `src/modules/lab-audits/*`, `src/modules/reports/*`, `prisma/seed-lab-demo.ts`.
- **Frontend (existing):** `src/lib/types.ts`, `src/lib/format.ts`, `src/components/user-menu.tsx`, `src/components/icons.tsx`, `src/app/(app)/audit/page.tsx`, `src/app/(app)/reports/page.tsx`, `README.md`, `docs/PLAN.md` (roadmap).
- **Frontend (new):** routes and components listed in section 5.
- **Must not change:** ledger, items, auth and security modules; `bottom-dock.tsx`.

Side note (out of scope, not to be fixed now): `items.service.ts` `update` reads the item outside its transaction.

---

## 10. Decisions needing approval (recommended default first)

1. **Position codes:** `A-R3-S2`; blocks A, B…; row 1 nearest the board; seat 1 on the left when facing the board. *(Alternative: L/R for two blocks.)*
2. **Equipment codes:** per room, `MON-07`, numbered by PC number; a replacement keeps the code.
3. **Who configures layouts:** Admin + HOD (own department). TOs edit equipment details, not layouts.
4. **Layout edits during an open audit:** structural changes blocked; equipment changes allowed via explicit sync.
5. **Approvals:** nobody — Admin included — approves an audit they performed (stricter than the ledger rule).
6. **Not checked at submit:** allowed only with a reason, shown as incomplete with % in the report. *(Alternative: block submit until everything is checked.)*
7. **Report engine:** pdfmake + `docx` on the backend, from snapshots; browser print as preview only.
8. **Packages to install:** `vitest`, `supertest`, `pdfmake`, `docx`, possibly `@resvg/resvg-wasm`.
9. **Real-data hosting:** local Postgres or campus server for the pilot, not free cloud tiers.
10. **Copy last month:** suggestions only, each must be confirmed; never counted as inspected.

---

## 11. Final acceptance checklist

- [ ] An existing location can become a room; other locations do not appear as labs.
- [ ] 2 blocks × 8 rows with varying seats, empty tables, gaps and an instructor desk are configured, previewed and saved; every position shows `A-R3-S2`.
- [ ] Searching `MON-07` highlights its desk.
- [ ] A PC shows its monitor code; replacing the monitor keeps the same PC, and the old monitor's history remains.
- [ ] Dual monitors and custom equipment types work; fault reasons come from a table.
- [ ] One audit per room per month; a second gets 409.
- [ ] Exactly one check per target; retried requests never create duplicates.
- [ ] Not checked never counts as working; every fault, missing and removed item has a reason.
- [ ] Bulk "all working" asks for confirmation and does not overwrite items already marked.
- [ ] Copied suggestions are not counted until confirmed.
- [ ] Two devices editing the same check get a conflict prompt, not a silent overwrite.
- [ ] Refreshing mid-audit loses nothing that was queued.
- [ ] Submitted and approved audits cannot be edited; return → resubmit creates a new revision; history is visible.
- [ ] A report downloaded later is identical even after the room has changed.
- [ ] PDF and DOCX pass the A4, page-number, repeated-header, signature and grayscale checks.
- [ ] Viewers cannot write, TOs cannot change layouts, other departments get 404 — all enforced in the backend.
- [ ] Ledger, items and existing audit screens behave exactly as before; no `asset_items` or `ledger_entries` rows changed.
- [ ] Only mock data used in development.

---

**Next step:** approve the decisions in section 10 (especially **8 — packages** and **6 — submit with unchecked items**). Implementation would start with **M0** before any schema change.
