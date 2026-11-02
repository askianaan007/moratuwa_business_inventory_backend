-- Serial number capture lists. Additive only: three new tables, no changes to existing ones.

-- CreateTable
CREATE TABLE "serial_lists" (
    "id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "location" TEXT,
    "notes" TEXT,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "serial_lists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "serial_units" (
    "id" UUID NOT NULL,
    "list_id" UUID NOT NULL,
    "product_number" TEXT NOT NULL,
    "label" TEXT,
    "sort_order" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "serial_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "serial_components" (
    "id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "serial_no" TEXT NOT NULL,
    "brand" TEXT,
    "model" TEXT,
    "sort_order" INTEGER NOT NULL,

    CONSTRAINT "serial_components_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "serial_lists_department_id_deleted_at_idx" ON "serial_lists"("department_id", "deleted_at");

-- CreateIndex
CREATE INDEX "serial_units_list_id_sort_order_idx" ON "serial_units"("list_id", "sort_order");

-- CreateIndex
CREATE INDEX "serial_components_unit_id_sort_order_idx" ON "serial_components"("unit_id", "sort_order");

-- CreateIndex
CREATE INDEX "serial_components_serial_no_idx" ON "serial_components"("serial_no");

-- AddForeignKey
ALTER TABLE "serial_lists" ADD CONSTRAINT "serial_lists_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serial_lists" ADD CONSTRAINT "serial_lists_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serial_units" ADD CONSTRAINT "serial_units_list_id_fkey" FOREIGN KEY ("list_id") REFERENCES "serial_lists"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "serial_components" ADD CONSTRAINT "serial_components_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "serial_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

