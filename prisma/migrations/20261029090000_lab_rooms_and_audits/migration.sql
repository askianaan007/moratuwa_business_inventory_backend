-- Lab rooms & monthly lab audit (repot-v2.md). Additive only: new enums, new
-- tables, and two new columns on locations with defaults.

-- CreateEnum
CREATE TYPE "RoomType" AS ENUM ('LAB', 'CLASSROOM', 'STORE', 'OFFICE', 'OTHER');

-- CreateEnum
CREATE TYPE "SeatKind" AS ENUM ('PC', 'EMPTY_TABLE', 'NO_TABLE', 'INSTRUCTOR');

-- CreateEnum
CREATE TYPE "EquipmentScope" AS ENUM ('WORKSTATION', 'ROOM', 'BOTH');

-- CreateEnum
CREATE TYPE "EquipmentState" AS ENUM ('IN_SERVICE', 'AT_REPAIR', 'RETIRED');

-- CreateEnum
CREATE TYPE "LabCheckStatus" AS ENUM ('WORKING', 'NOT_WORKING', 'NEEDS_REPAIR', 'MISSING', 'REMOVED', 'NOT_CHECKED');

-- CreateEnum
CREATE TYPE "LabAuditStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'RETURNED', 'APPROVED');

-- CreateEnum
CREATE TYPE "CheckTargetKind" AS ENUM ('EQUIPMENT', 'SEAT');

-- AlterTable
ALTER TABLE "locations" ADD COLUMN     "layout_version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "room_type" "RoomType" NOT NULL DEFAULT 'OTHER';

-- CreateTable
CREATE TABLE "room_blocks" (
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_rows" (
    "id" UUID NOT NULL,
    "block_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seats" (
    "id" UUID NOT NULL,
    "row_id" UUID NOT NULL,
    "order" INTEGER NOT NULL,
    "kind" "SeatKind" NOT NULL DEFAULT 'PC',
    "note" TEXT,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workstations" (
    "id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "seat_id" UUID,
    "number" INTEGER NOT NULL,
    "label_override" TEXT,
    "active_seat_key" TEXT,
    "active_number_key" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workstations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equipment_types" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "EquipmentScope" NOT NULL,
    "code_prefix" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_auditable" BOOLEAN NOT NULL DEFAULT true,
    "max_per_workstation" INTEGER NOT NULL DEFAULT 1,
    "category_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "equipment_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fault_reasons" (
    "id" UUID NOT NULL,
    "type_id" UUID,
    "label" TEXT NOT NULL,
    "group" TEXT NOT NULL DEFAULT 'OTHER',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fault_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equipment" (
    "id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "workstation_id" UUID,
    "type_id" UUID NOT NULL,
    "slot" INTEGER NOT NULL DEFAULT 1,
    "code" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "brand" TEXT,
    "model_no" TEXT,
    "serial_no" TEXT,
    "asset_item_id" UUID,
    "state" "EquipmentState" NOT NULL DEFAULT 'IN_SERVICE',
    "replaces_id" UUID,
    "wall" TEXT,
    "x" DOUBLE PRECISION,
    "y" DOUBLE PRECISION,
    "notes" TEXT,
    "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMP(3),
    "retired_reason" TEXT,
    "active_code_key" TEXT,
    "active_slot_key" TEXT,
    "active_asset_key" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "equipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_audits" (
    "id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "period" DATE NOT NULL,
    "reference" TEXT NOT NULL,
    "auditor_name" TEXT NOT NULL,
    "auditor_designation" TEXT,
    "started_on" DATE NOT NULL,
    "completed_on" DATE,
    "status" "LabAuditStatus" NOT NULL DEFAULT 'DRAFT',
    "general_remarks" TEXT,
    "recommendations" TEXT,
    "layout_version_at_start" INTEGER NOT NULL,
    "copied_from_audit_id" UUID,
    "created_by_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lab_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_audit_checks" (
    "id" UUID NOT NULL,
    "audit_id" UUID NOT NULL,
    "target_kind" "CheckTargetKind" NOT NULL,
    "equipment_id" UUID,
    "seat_id" UUID,
    "target_key" TEXT NOT NULL,
    "sort_key" TEXT NOT NULL,
    "position_code" TEXT,
    "workstation_id" UUID,
    "station_label" TEXT,
    "type_code" TEXT NOT NULL,
    "type_name" TEXT NOT NULL,
    "item_code" TEXT NOT NULL,
    "serial_no" TEXT,
    "asset_tag" TEXT,
    "status" "LabCheckStatus" NOT NULL DEFAULT 'NOT_CHECKED',
    "fault_reason_id" UUID,
    "reason_text" TEXT,
    "notes" TEXT,
    "action_taken" TEXT,
    "follow_up" TEXT,
    "suggested_status" "LabCheckStatus",
    "suggested_reason" TEXT,
    "added_after_start" BOOLEAN NOT NULL DEFAULT false,
    "target_retired_after_start" BOOLEAN NOT NULL DEFAULT false,
    "checked_at" TIMESTAMP(3),
    "checked_by_id" UUID,
    "last_mutation_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "lab_audit_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_audit_transitions" (
    "id" UUID NOT NULL,
    "audit_id" UUID NOT NULL,
    "from" "LabAuditStatus",
    "to" "LabAuditStatus" NOT NULL,
    "actor_id" UUID NOT NULL,
    "comment" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lab_audit_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_audit_snapshots" (
    "id" UUID NOT NULL,
    "audit_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "sha256" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lab_audit_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_settings" (
    "department_id" UUID NOT NULL,
    "institution" TEXT NOT NULL,
    "faculty" TEXT,
    "department_title" TEXT NOT NULL,
    "hod_name" TEXT,
    "hod_designation" TEXT,
    "checked_by_label" TEXT,
    "footer_note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_settings_pkey" PRIMARY KEY ("department_id")
);

-- CreateIndex
CREATE INDEX "room_blocks_location_id_idx" ON "room_blocks"("location_id");

-- CreateIndex
CREATE INDEX "room_rows_block_id_idx" ON "room_rows"("block_id");

-- CreateIndex
CREATE INDEX "seats_row_id_idx" ON "seats"("row_id");

-- CreateIndex
CREATE UNIQUE INDEX "workstations_active_seat_key_key" ON "workstations"("active_seat_key");

-- CreateIndex
CREATE UNIQUE INDEX "workstations_active_number_key_key" ON "workstations"("active_number_key");

-- CreateIndex
CREATE INDEX "workstations_location_id_idx" ON "workstations"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "equipment_types_code_key" ON "equipment_types"("code");

-- CreateIndex
CREATE UNIQUE INDEX "equipment_active_code_key_key" ON "equipment"("active_code_key");

-- CreateIndex
CREATE UNIQUE INDEX "equipment_active_slot_key_key" ON "equipment"("active_slot_key");

-- CreateIndex
CREATE UNIQUE INDEX "equipment_active_asset_key_key" ON "equipment"("active_asset_key");

-- CreateIndex
CREATE INDEX "equipment_location_id_idx" ON "equipment"("location_id");

-- CreateIndex
CREATE INDEX "equipment_workstation_id_idx" ON "equipment"("workstation_id");

-- CreateIndex
CREATE UNIQUE INDEX "lab_audits_reference_key" ON "lab_audits"("reference");

-- CreateIndex
CREATE INDEX "lab_audits_department_id_period_idx" ON "lab_audits"("department_id", "period");

-- CreateIndex
CREATE UNIQUE INDEX "lab_audits_location_id_period_key" ON "lab_audits"("location_id", "period");

-- CreateIndex
CREATE UNIQUE INDEX "lab_audit_checks_audit_id_target_key_key" ON "lab_audit_checks"("audit_id", "target_key");

-- CreateIndex
CREATE INDEX "lab_audit_transitions_audit_id_idx" ON "lab_audit_transitions"("audit_id");

-- CreateIndex
CREATE UNIQUE INDEX "lab_audit_snapshots_audit_id_revision_key" ON "lab_audit_snapshots"("audit_id", "revision");

-- AddForeignKey
ALTER TABLE "room_blocks" ADD CONSTRAINT "room_blocks_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_rows" ADD CONSTRAINT "room_rows_block_id_fkey" FOREIGN KEY ("block_id") REFERENCES "room_blocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seats" ADD CONSTRAINT "seats_row_id_fkey" FOREIGN KEY ("row_id") REFERENCES "room_rows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstations" ADD CONSTRAINT "workstations_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstations" ADD CONSTRAINT "workstations_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstations" ADD CONSTRAINT "workstations_seat_id_fkey" FOREIGN KEY ("seat_id") REFERENCES "seats"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment_types" ADD CONSTRAINT "equipment_types_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fault_reasons" ADD CONSTRAINT "fault_reasons_type_id_fkey" FOREIGN KEY ("type_id") REFERENCES "equipment_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_workstation_id_fkey" FOREIGN KEY ("workstation_id") REFERENCES "workstations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_type_id_fkey" FOREIGN KEY ("type_id") REFERENCES "equipment_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_asset_item_id_fkey" FOREIGN KEY ("asset_item_id") REFERENCES "asset_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_replaces_id_fkey" FOREIGN KEY ("replaces_id") REFERENCES "equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_audits" ADD CONSTRAINT "lab_audits_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_audits" ADD CONSTRAINT "lab_audits_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_audits" ADD CONSTRAINT "lab_audits_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_audit_checks" ADD CONSTRAINT "lab_audit_checks_audit_id_fkey" FOREIGN KEY ("audit_id") REFERENCES "lab_audits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_audit_checks" ADD CONSTRAINT "lab_audit_checks_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_audit_checks" ADD CONSTRAINT "lab_audit_checks_seat_id_fkey" FOREIGN KEY ("seat_id") REFERENCES "seats"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_audit_checks" ADD CONSTRAINT "lab_audit_checks_fault_reason_id_fkey" FOREIGN KEY ("fault_reason_id") REFERENCES "fault_reasons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_audit_checks" ADD CONSTRAINT "lab_audit_checks_checked_by_id_fkey" FOREIGN KEY ("checked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_audit_transitions" ADD CONSTRAINT "lab_audit_transitions_audit_id_fkey" FOREIGN KEY ("audit_id") REFERENCES "lab_audits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_audit_transitions" ADD CONSTRAINT "lab_audit_transitions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_audit_snapshots" ADD CONSTRAINT "lab_audit_snapshots_audit_id_fkey" FOREIGN KEY ("audit_id") REFERENCES "lab_audits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_audit_snapshots" ADD CONSTRAINT "lab_audit_snapshots_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_settings" ADD CONSTRAINT "report_settings_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Hand-written constraints (Prisma does not model CHECK constraints) ──

-- Every audit check points at exactly one target, matching its kind.
ALTER TABLE "lab_audit_checks" ADD CONSTRAINT "lab_audit_checks_one_target_chk" CHECK (
  ("target_kind" = 'EQUIPMENT' AND "equipment_id" IS NOT NULL AND "seat_id" IS NULL AND "target_key" = 'E:' || "equipment_id"::text)
  OR
  ("target_kind" = 'SEAT' AND "seat_id" IS NOT NULL AND "equipment_id" IS NULL AND "target_key" = 'S:' || "seat_id"::text)
);

-- A non-working observation always carries a reason.
ALTER TABLE "lab_audit_checks" ADD CONSTRAINT "lab_audit_checks_reason_chk" CHECK (
  "status" IN ('WORKING', 'NOT_CHECKED') OR "fault_reason_id" IS NOT NULL OR COALESCE(btrim("reason_text"), '') <> ''
);

-- Audit periods are the first day of a month; completion is not before the start.
ALTER TABLE "lab_audits" ADD CONSTRAINT "lab_audits_period_chk" CHECK (date_trunc('month', "period") = "period");
ALTER TABLE "lab_audits" ADD CONSTRAINT "lab_audits_dates_chk" CHECK ("completed_on" IS NULL OR "completed_on" >= "started_on");

-- Equipment is either at a PC or a room fixture; slots and numbers are positive.
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_slot_chk" CHECK ("slot" >= 1 AND "number" >= 0);
ALTER TABLE "equipment" ADD CONSTRAINT "equipment_retired_chk" CHECK (
  "state" <> 'RETIRED' OR ("active_code_key" IS NULL AND "active_slot_key" IS NULL AND "active_asset_key" IS NULL AND "retired_at" IS NOT NULL)
);
