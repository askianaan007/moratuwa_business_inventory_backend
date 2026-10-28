# Lab Rooms & Monthly Lab Audit — Analysis and Plan

Status: **plan only, no code written yet.**
Backend: `moratuwa_backend` (Express 5 + Prisma 7 + PostgreSQL)
Frontend: `moratuwa_frontend/src` (Next.js 16 + Tailwind 4 + daisyUI 5)

---

## 1. What is being asked

| # | Requirement | Notes |
|---|---|---|
| 1 | Create **lab rooms / class rooms** with a name and code | Builds on the existing `Location` table |
| 2 | Admin sets the **layout**: how many column blocks, how many rows, how many PCs per row | Current lab: 2 columns × 8 rows. Must be editable, not hard-coded |
| 3 | Rows can differ: one row has 8 PCs, another has empty tables, another is shorter | Every seat is set one by one: PC / empty table / no table |
| 4 | Each PC (workstation) has **Monitor, CPU, UPS, Mouse, Keyboard**, and admin can add more item types (headset, webcam …) | Item types are a table, not an enum |
| 5 | Every item has its own **code and number** (MON-01, CPU-01, UPS-01 …) | Optionally linked to the ledger asset tag |
| 6 | A PC is **named after its monitor** (e.g. "MON-07") | The "primary" item type decides the PC name |
| 7 | Room-level items: **AC, teaching monitor / smart board, projector, fans, whiteboard, router …** | Placed on the floor plan, audited too |
| 8 | **Top-view simulation** of the room | SVG floor plan: front wall, door, desks, PCs, AC, coloured by status |
| 9 | **Monthly audit**: check every item → Working / Not working / … with a **reason** when not working | Fast tap-through on a phone |
| 10 | **A4 report (PDF + Word)** to submit to the Head of Department, with auditor name, audit dates, signatures | Same layout every month |
| 11 | Proper **tabs** in the app | Lab setup, audit, report |

---

## 2. What already exists and how it fits

| Existing piece | Reuse? |
|---|---|
| `Location` (department, code, name, building, floor) | **Yes.** A lab room *is* a location. Add `roomType` and layout tables beside it instead of a parallel "Room" table, so ledger items, movements and the Board-of-Survey audit keep working with the same room. |
| `AssetItem` (tag code, serial, condition, status, locationId) | **Optional link.** A lab component can point to an `AssetItem` when the item is in the ledger. Not required, so a lab can be set up today before the ledger is fully typed in. |
| `AuditSession` / `AuditRecord` | **Keep separate.** These are the yearly QR-scan *stock verification* (found / missing / elsewhere). The monthly lab check is a different job (working / not working + reason, by seat). Mixing them would make both confusing. A closed monthly audit can later update `AssetItem.condition`. |
| `Role` enum (ADMIN, HOD, TECHNICAL_OFFICER, VIEWER) | **Yes.** Admin (and HOD) set up rooms; TO runs audits; HOD approves. |
| `activity_log`, soft delete, `{ data }` responses, Zod schemas, department scope | **Yes**, follow the same conventions (README → Conventions). |
| Frontend `/audit` and `/reports` pages (currently "Coming soon") | **Replace** with the real screens below. |

---

## 3. Data model (Prisma)

### 3.1 Diagram

```
Department ─┬─ Location (roomType = LAB | CLASSROOM | STORE | OFFICE)
            │     ├─ RoomBlock        (a column of desks: "Left", "Right")
            │     │     └─ Seat       (block, row, position, kind = PC | EMPTY_TABLE | NO_TABLE)
            │     │           └─ Workstation (only for kind = PC)
            │     │                 └─ Component (type, code, number, serial, assetItem?)
            │     └─ RoomFixture      (AC, teaching monitor, projector … with x/y on the plan)
            │
            ├─ ComponentType          (Monitor, CPU, UPS, Mouse, Keyboard, AC … admin-managed)
            ├─ LabAudit               (room, month, auditor, dates, status)
            │     └─ LabAuditCheck    (one row per component / fixture / empty seat)
            └─ ReportSettings         (institution name, HOD name, logo, signature labels)
```

### 3.2 New enums

```prisma
enum RoomType      { LAB  CLASSROOM  STORE  OFFICE }
enum SeatKind      { PC  EMPTY_TABLE  NO_TABLE }      // NO_TABLE = gap / walkway
enum ComponentScope { WORKSTATION  ROOM }             // where a type can be used
enum CheckStatus   {
  WORKING
  NOT_WORKING
  NEEDS_REPAIR      // works but faulty (flickering, sticky keys …)
  MISSING
  REMOVED           // taken out on purpose (sent for repair, moved)
  NOT_CHECKED
}
enum LabAuditStatus { DRAFT  SUBMITTED  APPROVED  RETURNED }
enum Wall           { FRONT  BACK  LEFT  RIGHT  CEILING  FLOOR }
```

### 3.3 New / changed models

```prisma
model Location {
  // … existing fields …
  roomType  RoomType @default(LAB) @map("room_type")
  capacity  Int?                                   // students, for classrooms
  frontWall Wall     @default(FRONT) @map("front_wall") // which side the teacher/board is
  blocks    RoomBlock[]
  fixtures  RoomFixture[]
  labAudits LabAudit[]
}

/// A vertical column of desks seen from the top. The current lab has 2.
model RoomBlock {
  id         String @id @default(uuid()) @db.Uuid
  locationId String @map("location_id") @db.Uuid
  name       String              // "Left", "Right", "Block A"
  order      Int                 // left → right on the plan
  rows       Int                 // number of rows in this block (e.g. 8)
  seatsPerRow Int @map("seats_per_row") // default seats per row; each seat can still be changed
  seats      Seat[]
  @@unique([locationId, order])
}

/// One desk position. Row 1 is nearest the front wall.
model Seat {
  id       String   @id @default(uuid()) @db.Uuid
  blockId  String   @map("block_id") @db.Uuid
  row      Int
  position Int                  // 1 … seatsPerRow, left → right
  kind     SeatKind @default(PC)
  note     String?              // "broken table", "reserved for instructor"
  workstation Workstation?
  @@unique([blockId, row, position])
}

/// A PC on a seat. Its display name comes from the primary component (the monitor).
model Workstation {
  id        String  @id @default(uuid()) @db.Uuid
  seatId    String  @unique @map("seat_id") @db.Uuid
  number    Int                       // running PC number in the room: 1, 2, 3 …
  label     String?                   // optional manual override, else monitor code
  components Component[]
  @@unique([seatId])
}

/// Admin-managed list: Monitor, CPU, UPS, Mouse, Keyboard, Headset, AC, Projector …
model ComponentType {
  id         String         @id @default(uuid()) @db.Uuid
  code       String         @unique  // "MON", "CPU", "UPS", "MSE", "KBD", "AC"
  name       String
  scope      ComponentScope            // WORKSTATION or ROOM
  isPrimary  Boolean @default(false)  // true for Monitor → names the PC
  isDefault  Boolean @default(false)  // auto-added to every new PC
  sortOrder  Int     @default(0)       // column order in the audit and report
  isActive   Boolean @default(true)
  reasons    String[]                  // quick-pick fault reasons for this type
}

/// One physical item at a PC (monitor, CPU, …).
model Component {
  id            String  @id @default(uuid()) @db.Uuid
  workstationId String  @map("workstation_id") @db.Uuid
  typeId        String  @map("type_id") @db.Uuid
  code          String                 // printed label, e.g. "MON-07"
  number        Int                    // 7
  brand         String?
  modelNo       String?
  serialNo      String?
  assetItemId   String? @unique        // optional link to the ledger item / QR tag
  @@unique([workstationId, typeId])     // one monitor per PC (relax later for dual monitors)
}

/// Room-level item placed on the top view.
model RoomFixture {
  id          String  @id @default(uuid()) @db.Uuid
  locationId  String
  typeId      String                   // ComponentType with scope = ROOM
  code        String                   // "AC-01", "TV-01"
  number      Int
  wall        Wall                     // where it is mounted
  x           Float                    // 0–100 % across the plan
  y           Float                    // 0–100 % down the plan
  brand, modelNo, serialNo, assetItemId  // same as Component
}

/// One monthly check of one room.
model LabAudit {
  id           String         @id @default(uuid()) @db.Uuid
  locationId   String
  period       String                    // "2026-10"  (one audit per room per month)
  title        String                    // "Monthly Lab Audit — October 2026"
  auditorName  String                    // typed in, defaults to the signed-in user
  auditorTitle String?                   // "Technical Officer"
  startedOn    DateTime @db.Date
  completedOn  DateTime? @db.Date
  status       LabAuditStatus @default(DRAFT)
  remarks      String?                   // general remarks on the report
  layoutSnapshot Json                    // frozen copy of blocks/seats/labels at start
  createdById, submittedAt, approvedById, approvedAt, hodComment
  checks       LabAuditCheck[]
  @@unique([locationId, period])
}

/// One line of the audit: a component, a fixture, or an empty seat.
model LabAuditCheck {
  id          String      @id @default(uuid()) @db.Uuid
  auditId     String
  seatId      String?
  componentId String?
  fixtureId   String?
  // Snapshot so old reports never change when the lab is re-arranged:
  stationLabel String?                  // "MON-07"
  itemTypeCode String                   // "CPU" or "SEAT" for an empty-table check
  itemCode     String                   // "CPU-07"
  status      CheckStatus @default(NOT_CHECKED)
  reason      String?                   // required when status ≠ WORKING
  action      String?                   // "Reported to IT", "Replaced cable"
  checkedAt   DateTime?
  checkedById String?
  @@unique([auditId, componentId])
  @@unique([auditId, fixtureId])
}

/// Report header and signature text, one row per department.
model ReportSettings {
  departmentId   String @id
  institution    String   // "University of Moratuwa"
  departmentName String   // "Department of …"
  hodName        String?
  hodTitle       String?  // "Head of Department"
  logoKey        String?
  footerNote     String?
}
```

### 3.4 Rules the service layer enforces

- **PC name** = `Workstation.label` if set, otherwise the code of its component whose type `isPrimary` (Monitor), otherwise `PC-<number>`.
- **Codes** are generated per room and type: `MON-01 … MON-16`, `CPU-01 …`. Admin can edit any code. Codes are unique inside a room. (Optional prefix with room code, e.g. `LAB2-MON-07`, as a setting.)
- **Changing the layout** (fewer rows, seat turned into EMPTY_TABLE) is blocked while a DRAFT audit is open for that room, and never deletes history: workstations get `deletedAt`, old audits keep their `layoutSnapshot`.
- **Starting an audit** creates every `LabAuditCheck` row up front (all components + fixtures + one row per EMPTY_TABLE seat), so progress = checked / total, and the report always lists everything.
- **Submit** is refused while any row is `NOT_CHECKED` or a non-working row has no reason.
- **Approve** (HOD/Admin) locks the audit. Optionally: items marked NOT_WORKING / NEEDS_REPAIR update the linked `AssetItem.condition`, MISSING updates `AssetItem.status`.
- **Copy last month**: a new audit can pre-fill statuses from the previous approved audit, so the TO only changes what differs (faults usually carry over).

### 3.5 Migration

One migration `2026XXXX_lab_rooms_and_monthly_audit`: new enums, new tables, `ALTER TABLE locations ADD room_type … DEFAULT 'LAB'`. Seed adds the default component types:

| Code | Name | Scope | Primary | Default on new PC | Quick reasons |
|---|---|---|---|---|---|
| MON | Monitor | WORKSTATION | ✅ | ✅ | No display, flickering, dead pixels, cable damaged, no power |
| CPU | CPU / System unit | WORKSTATION | | ✅ | Not booting, slow, OS error, no network, overheating |
| UPS | UPS | WORKSTATION | | ✅ | Battery dead, beeping, no output |
| KBD | Keyboard | WORKSTATION | | ✅ | Keys not working, missing keys, not detected |
| MSE | Mouse | WORKSTATION | | ✅ | Not detected, scroll broken, buttons broken |
| AC | Air conditioner | ROOM | | | Not cooling, leaking, remote missing, noisy |
| TV | Teaching monitor / Smart board | ROOM | | | No display, no input, touch not working |
| PRJ | Projector | ROOM | | | Lamp, no signal, blurry |
| FAN, WB, SPK, RTR … | Fan, whiteboard, speakers, router | ROOM | | | |

---

## 4. Backend API (new module `src/modules/rooms` and `src/modules/lab-audits`)

Same structure as `ledger`: `*.routes.ts → *.controller.ts → *.service.ts`, Zod in `*.schema.ts`, every write in a transaction + `logActivity`.

### Rooms & layout

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/rooms?roomType` | any | Rooms with PC count, fixture count, last audit month + result |
| GET | `/rooms/:id` | any | Full room: blocks → seats → workstation → components, fixtures |
| POST | `/rooms` | Admin, HOD | Create room (creates the `Location`) |
| PATCH | `/rooms/:id` | Admin, HOD | Name, code, type, building, floor, front wall |
| PUT | `/rooms/:id/layout` | Admin, HOD | **Layout wizard**: `{ blocks: [{ name, rows, seatsPerRow }] }` → creates seats + PCs + default components with auto codes. Dry-run flag returns a preview first |
| PATCH | `/seats/:id` | Admin, HOD | Change one seat: PC ↔ EMPTY_TABLE ↔ NO_TABLE, note |
| PATCH | `/rooms/:id/rows` | Admin, HOD | Bulk: "block Right, row 6 → all EMPTY_TABLE" or "row 3 has 6 seats" |
| POST | `/workstations/:id/components` · PATCH/DELETE `/components/:id` | Admin, HOD, TO | Add a headset, change codes, serials, link a ledger tag |
| POST | `/rooms/:id/renumber` | Admin, HOD | Re-number PCs in reading order (front-left → back-right) |
| POST/PATCH/DELETE | `/rooms/:id/fixtures` · `/fixtures/:id` | Admin, HOD | AC, teaching monitor … with position |
| GET/POST/PATCH | `/component-types` | Admin | Manage item types and their quick reasons |

### Monthly audits

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `/lab-audits?roomId&period&status` | any | List / history |
| POST | `/lab-audits` | Admin, HOD, TO | `{ roomId, period, auditorName, auditorTitle, startedOn, copyFromLast }` |
| GET | `/lab-audits/:id` | any | Audit + all checks, grouped by seat, with summary counts |
| PATCH | `/lab-audits/:id/checks` | Admin, HOD, TO | **Batch** `[{ checkId, status, reason, action }]` — one call for "mark whole PC working" or "mark whole room working" |
| PATCH | `/lab-audits/:id` | Admin, HOD, TO | Dates, auditor, remarks (DRAFT only) |
| POST | `/lab-audits/:id/submit` | Admin, HOD, TO | Validates and submits to HOD |
| POST | `/lab-audits/:id/decision` | Admin, HOD | Approve / return with comment |
| GET | `/lab-audits/:id/report.pdf` | any | A4 PDF |
| GET | `/lab-audits/:id/report.docx` | any | Word file (editable before printing) |
| GET | `/rooms/:id/fault-history` | any | Per item: how many months not working (for the report's "repeated faults") |
| GET/PUT | `/report-settings` | Admin | Header, HOD name, logo |

---

## 5. Frontend (`moratuwa_frontend/src`)

> Read `node_modules/next/dist/docs/` before writing (AGENTS.md: this Next.js version has breaking changes).

### 5.1 Navigation / tabs

The bottom dock has 5 slots (`components/bottom-dock.tsx`). Keep 5 and make **Audit** the home of this feature:

`Home · Ledger · Scan · Audit · Reports`

- **Audit tab** (`/audit`) → top tabs (daisyUI `tabs tabs-box`):
  `Monthly lab audit` | `Lab rooms` | `Stock verification` (existing Phase 2 placeholder)
- **Reports tab** (`/reports`) → `Lab audit reports` list (by room and month) with PDF / Word buttons.
- **Settings / admin** (from user menu): `Item types`, `Report header`.

### 5.2 Routes and files

```
src/app/(app)/
  audit/
    layout.tsx                 top tabs
    page.tsx                   Monthly lab audit: this month's status per room
    rooms/
      page.tsx                 room cards (name, PCs, faults, last audit)
      new/page.tsx             create room
      [roomId]/page.tsx        TOP VIEW of the room + item list
      [roomId]/setup/page.tsx  layout wizard + seat editor (admin)
      [roomId]/fixtures/…      AC, teaching monitor placement
    labs/[auditId]/
      page.tsx                 audit run screen (top view + check sheet)
      summary/page.tsx         review before submit
      print/page.tsx           A4 print view (also used for PDF)
  reports/page.tsx             report list
  settings/item-types/…        component types (admin)
  settings/report/…            header / HOD
src/components/room/
  room-plan.tsx                SVG top view (shared by view, setup, audit, report)
  seat-cell.tsx                one desk: monitor + CPU + UPS icons, status dots
  fixture-marker.tsx           AC, TV, projector, door
  station-sheet.tsx            bottom sheet: checks for one PC
  status-badge.tsx             colour + icon per CheckStatus
  layout-wizard.tsx
src/lib/types.ts               add Room, Seat, Workstation, Component, LabAudit …
```

### 5.3 Top-view simulation (`room-plan.tsx`)

Pure **SVG + React**, no extra library. Same component in four modes: `view | setup | audit | print`.

```
            ┌───────────────── FRONT (whiteboard) ─────────────────┐
  [AC-01]   │   [TV-01 teaching monitor]          [PRJ-01]         │  [AC-02]
            │                                                      │
            │   Block LEFT                     Block RIGHT         │
  row 1     │  [MON-01][MON-02][MON-03] │ aisle │ [MON-09][MON-10] │
  row 2     │  [MON-04][MON-05][  ▢   ] │       │ [MON-11][MON-12] │
  …         │                           │       │                  │
  row 8     │  [  ▢  ][  ▢  ][  ▢  ]    │       │ [MON-16]  ·      │
            └──────────────────────────────────────────── [DOOR] ──┘
     ▢ = empty table    · = no table    colours = audit status
```

- Desk drawn as a rounded rect; inside: small monitor icon + label (monitor code) + 5 tiny status dots (MON, CPU, UPS, KBD, MSE).
- Colours: green = all working, amber = needs repair, red = something not working, grey = not checked, outlined = empty table, nothing = no table. Colour **plus** an icon/pattern so it still reads in black-and-white print.
- Front wall at top; fixtures drawn on walls by `wall` + `x/y`.
- Phone: plan scrolls horizontally inside its card if wide; pinch/zoom via CSS `transform` buttons (+ / −). Tap a desk → `station-sheet`.
- Setup mode: tap a desk to cycle PC → Empty table → No table; long-press for details; "+ row", "− row" per block; drag fixtures.

### 5.4 Layout wizard (admin)

1. Room details: name, code (e.g. `ELEC-LAB-02`), type (Lab / Classroom), building, floor.
2. Blocks: "How many columns?" → `2`. For each: name, rows `8`, seats per row `n`.
3. Preview the top view → tap seats to mark empty tables / gaps, or change seats in one row.
4. Items per PC: tick default types (Monitor, CPU, UPS, Keyboard, Mouse, + custom). Code style: `MON-01` or `LAB2-MON-01`. Numbering order: front-left → back-right.
5. Room fixtures: add AC ×2, teaching monitor, projector … and place them.
6. Save → creates everything in one transaction.

### 5.5 Audit run screen (fast on a phone)

- Header: room, month, progress bar `42 / 96 checked`, auditor name.
- Top view in audit mode; untouched desks grey.
- Tap a PC → bottom sheet lists its items:
  `MON-07  [✓ Working] [✗ Not working] [⚠ Repair] [? Missing]`
  Non-working → quick-reason chips from the item type + free text + action taken.
- Big **"All working"** button per PC (one tap for the common case) and **"Mark remaining as working"** for the room (with confirm).
- Empty tables: one row each, "still empty / table damaged / PC installed".
- Fixtures section: AC, teaching monitor …
- List view toggle (table: PC × item columns) for desktop.
- Autosave each tap via the batch endpoint; show "Saving… / Saved".
- Summary → Submit to HOD.

---

## 6. The A4 report (for the Head of Department)

### 6.1 Contents (portrait A4, 15 mm margins)

1. **Header**: logo, University / Faculty / Department, title "Monthly Computer Lab Audit Report", room name + code, period (October 2026), report no. (`LA-ELEC-LAB-02-2026-10`).
2. **Audit details**: auditor name + designation (entered by you, remembered for next month), audit start and completion dates, date submitted.
3. **Summary box**: total seats, PCs, empty tables; items checked; Working / Not working / Needs repair / Missing per item type (small table: rows = item type, columns = statuses). Change vs last month (e.g. "+2 faults").
4. **Room top view** (the same SVG, print colours + legend).
5. **Faulty items list** (the part the HOD reads): PC, item code, type, status, reason, action taken, months not working.
6. **Full station register**: one row per PC — `No · PC (monitor) · MON · CPU · UPS · KBD · MSE · (extra types) · Remarks`, each cell ✓ / ✗ / ⚠ / ?.
7. **Room equipment**: AC, teaching monitor, projector … with status and reason.
8. **Remarks / recommendations**.
9. **Signatures**: Prepared by (auditor, date) · Checked by · **Head of Department** (name, signature, date). Approved state shows "Approved in system on …".
10. Footer on every page: report no., "Generated on …", `Page x of y`.

### 6.2 How PDF and Word are produced

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. Print page (recommended first)** | `/audit/labs/[id]/print` with `@page { size: A4; margin: 15mm }`, `break-inside: avoid`, user clicks "Download PDF" → `window.print()` → Save as PDF | No new dependency, identical to screen, SVG plan prints sharp, works on Vercel | Page numbers depend on the browser; user does the save step |
| B. Server PDF | Backend renders the same HTML with headless Chromium (`puppeteer-core` + `@sparticuz/chromium` on Vercel) → `report.pdf` | One-click file, exact page numbers, can be emailed later | Heavy dependency, cold starts on serverless |
| C. `@react-pdf/renderer` | Separate PDF layout in React | Light, no browser | Second layout to maintain, SVG plan must be redrawn |
| **Word (.docx)** | Backend `docx` npm package builds header, tables, signatures; plan embedded as PNG (SVG → PNG via `@resvg/resvg-js`) | HOD can edit before printing | Plan image instead of vector |

**Recommendation:** ship **A** (print-to-PDF) + **Word via `docx`** first; add **B** only if one-click PDF or email is needed.

---

## 7. Permissions

| Action | Admin | HOD | Technical Officer | Viewer |
|---|---|---|---|---|
| Create room, layout, fixtures, item types, report header | ✅ | ✅ (own dept) | ✗ | ✗ |
| Edit component codes / serials | ✅ | ✅ | ✅ | ✗ |
| Start / fill / submit audit | ✅ | ✅ | ✅ | ✗ |
| Approve / return audit | ✅ | ✅ (not own) | ✗ | ✗ |
| View rooms, audits, download reports | ✅ | ✅ | ✅ | ✅ |

---

## 8. Build order (milestones)

| # | Milestone | Backend | Frontend | Done when |
|---|---|---|---|---|
| 1 | **Data model** | Schema + migration + seed item types | `types.ts` | `prisma migrate dev` passes, typecheck clean |
| 2 | **Rooms & layout** | rooms, seats, workstations, components, fixtures, component-types | Lab rooms tab, layout wizard, seat editor | Your lab (2 columns × 8 rows, with empty tables) can be built and edited |
| 3 | **Top view** | — | `room-plan.tsx` view + setup modes, fixtures | Plan matches the real room, works on phone |
| 4 | **Monthly audit** | lab-audits, batch checks, submit/approve, copy-last-month | Audit run screen, station sheet, summary | A full room audit takes < 10 min on a phone |
| 5 | **Report** | report data endpoint, `.docx` export, report settings | Print view (A4 PDF), Reports tab | Printed report fits A4, signatures on last page |
| 6 | **Polish** | fault history, sync to `AssetItem.condition` | Dark mode, print in B&W, offline queue for checks | HOD signs off a real month |

Each milestone is one PR in each repo.

---

## 9. Testing / acceptance checklist

- Build current lab: 2 blocks × 8 rows; mark some seats empty; one row with fewer seats → plan and PC numbers are right.
- Add a "Headset" type → appears on every PC, in the audit and as a report column.
- Swap a monitor (new code) → PC name changes; last month's report still shows the old name (snapshot).
- Start October audit → all rows NOT_CHECKED; submit blocked until all checked and reasons given.
- "Copy last month" pre-fills faults.
- Second October audit for the same room → refused (one per month).
- Report: prints on A4 portrait, no row split across pages, legend readable in black-and-white, page x of y.
- TO cannot change the layout; Viewer cannot start an audit; other department → 404.

---

## 10. Questions to confirm before coding

1. **Layout of your lab**: is it **2 column blocks, each 8 rows, with several PCs per row** (how many per row?), or **2 PCs per row × 8 rows = 16 PCs**?
2. **PC name**: just the monitor code (`MON-07`) or with room prefix (`LAB2-MON-07`)? Do you already have codes stuck on the items to copy?
3. **Link to the ledger**: should each monitor/CPU be linked to its ledger QR tag now, or later?
4. **Report format**: is browser "Save as PDF" fine for the first version, plus a Word file? Any official template or form number the HOD expects?
5. **Approval**: does the HOD approve inside the app, or only sign the printed copy?
6. **Classrooms**: do they also have student desks/chairs to count, or only equipment (AC, teaching monitor, projector)?
