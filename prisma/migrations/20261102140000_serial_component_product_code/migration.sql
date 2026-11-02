-- Optional product code per part (e.g. a CPU's own). Additive: one nullable column, existing rows unchanged.

-- AlterTable
ALTER TABLE "serial_components" ADD COLUMN     "product_code" TEXT;

