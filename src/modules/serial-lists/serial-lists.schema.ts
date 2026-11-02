import { z } from "zod";

const optional = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);

// Barcode readers can add stray spaces or control characters; keep only the printable code.
const scanned = (label: string) =>
  z
    .string()
    .transform((v) => v.replace(/[\u0000-\u001f\u007f]/g, "").trim())
    .pipe(z.string().min(1, `${label} is required`).max(120));

export const idParams = z.object({ id: z.uuid() });
export const unitParams = z.object({ id: z.uuid(), unitId: z.uuid() });

export const listQuery = z.object({ departmentId: z.uuid().optional() });

export const createListSchema = z.object({
  departmentId: z.uuid().optional(),
  title: z.string().trim().min(2, "Give the list a name").max(120),
  location: optional(120),
  notes: optional(1000),
});

export const updateListSchema = createListSchema.omit({ departmentId: true }).partial();

const componentSchema = z.object({
  kind: z.string().trim().min(1, "Part is required").max(40),
  serialNo: scanned("Serial number"),
  brand: optional(80),
  model: optional(80),
  productCode: optional(120),
});

export const unitSchema = z
  .object({
    productNumber: scanned("Product number"),
    label: optional(60),
    components: z.array(componentSchema).min(1, "Add at least one part").max(20),
  })
  .superRefine((unit, ctx) => {
    const seen = new Map<string, number>();
    unit.components.forEach((c, i) => {
      const key = c.serialNo.toUpperCase();
      const first = seen.get(key);
      if (first !== undefined) {
        ctx.addIssue({ code: "custom", path: ["components", i, "serialNo"], message: `Same serial as part ${first + 1}` });
      } else seen.set(key, i);
    });
  });

export type CreateListInput = z.infer<typeof createListSchema>;
export type UpdateListInput = z.infer<typeof updateListSchema>;
export type UnitInput = z.infer<typeof unitSchema>;
