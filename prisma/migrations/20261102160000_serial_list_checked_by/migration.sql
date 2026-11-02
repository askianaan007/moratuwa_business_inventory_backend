-- "Checked by" name and designation for the serial list PDF. Additive: two nullable columns, existing rows unchanged.

-- AlterTable
ALTER TABLE "serial_lists" ADD COLUMN     "checked_by_designation" TEXT,
ADD COLUMN     "checked_by_name" TEXT;

