-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('RECEIPT', 'TRANSFER', 'DISPOSAL', 'RETURN');

-- AlterTable
ALTER TABLE "ledger_entries" DROP COLUMN "category",
ADD COLUMN     "category_id" UUID,
ADD COLUMN     "entry_type" "LedgerEntryType" NOT NULL DEFAULT 'RECEIPT',
ADD COLUMN     "hod_signed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "item_code" TEXT,
ADD COLUMN     "receipt_no" TEXT,
ADD COLUMN     "serial_no" TEXT,
ADD COLUMN     "sin_date" DATE,
ADD COLUMN     "sin_no" TEXT;

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "categories_code_key" ON "categories"("code");

-- CreateIndex
CREATE UNIQUE INDEX "categories_name_key" ON "categories"("name");

-- CreateIndex
CREATE INDEX "ledger_entries_entry_type_idx" ON "ledger_entries"("entry_type");

-- CreateIndex
CREATE INDEX "ledger_entries_category_id_idx" ON "ledger_entries"("category_id");

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

