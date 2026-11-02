import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { env } from "../../config/env.js";
import { authorize, currentUser } from "../../middlewares/authenticate.js";
import { AppError } from "../../utils/app-error.js";

/**
 * Reads serial / product numbers from a label photo with Google Gemini (free
 * tier). Called from the camera scanner when the barcode or the on-device text
 * reader fails. The API key stays on the server.
 */

// ─── Schemas ────────────────────────────────────────────────────────────

const readSchema = z.object({
  // Base64 JPEG/PNG/WebP, already shrunk in the browser (about 1600 px).
  image: z.string().min(100).max(2_000_000).regex(/^[A-Za-z0-9+/=]+$/, "image must be base64"),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  field: z.enum(["serial", "product"]),
  kind: z.string().trim().max(40).optional(), // Monitor, CPU …
});

const geminiAnswer = z.object({
  candidates: z
    .array(
      z.object({
        value: z.string(),
        printedLabel: z.string().nullish(),
        confidence: z.number().min(0).max(1).nullish(),
      }),
    )
    .default([]),
});

// ─── Gemini ─────────────────────────────────────────────────────────────

function prompt(field: "serial" | "product", kind?: string) {
  const what =
    field === "serial"
      ? "the SERIAL NUMBER (often printed after S/N, SN, Serial No., Serial #, or as the code under a barcode marked S/N)"
      : "the PRODUCT NUMBER (often printed after P/N, PN, Product No., Product #, MTM, Machine Type, SKU or Model No.)";
  return [
    `This is a photo of an equipment label${kind ? ` on a ${kind}` : ""} (computer, monitor, UPS, printer or similar).`,
    `Find ${what}.`,
    "Copy each value exactly as printed: keep letters, digits and dashes, remove spaces, do not guess hidden characters.",
    "Where a character is ambiguous (O/0, I/1, S/5, B/8), use the label's context and the usual format for this manufacturer.",
    `Do not return other numbers (model, MAC address, part number, barcode digits of a different field, voltage) as the ${field} number.`,
    "Return up to 5 candidates, most likely first, with the label text printed next to each (e.g. 'S/N') and a confidence from 0 to 1.",
    "If you cannot read it, return an empty list.",
  ].join("\n");
}

const responseSchema = {
  type: "OBJECT",
  properties: {
    candidates: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          value: { type: "STRING" },
          printedLabel: { type: "STRING", nullable: true },
          confidence: { type: "NUMBER" },
        },
        required: ["value", "confidence"],
      },
    },
  },
  required: ["candidates"],
};

export async function askGemini(input: z.infer<typeof readSchema>) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.GEMINI_MODEL)}:generateContent`;
  let res: globalThis.Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY! },
      body: JSON.stringify({
        contents: [{ parts: [{ inline_data: { mime_type: input.mimeType, data: input.image } }, { text: prompt(input.field, input.kind) }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema },
      }),
      signal: AbortSignal.timeout(25_000),
    });
  } catch {
    throw new AppError(504, "AI_TIMEOUT", "The AI reader did not answer in time. Try again or use offline reading.");
  }

  if (res.status === 429) throw new AppError(429, "AI_LIMIT", "The free AI limit was reached. Wait a minute, or use offline reading.");
  if (!res.ok) {
    // 400/403/404 usually mean a wrong key or model name: see GEMINI_API_KEY / GEMINI_MODEL.
    throw new AppError(502, "AI_UNAVAILABLE", `The AI reader is unavailable right now (code ${res.status}). Use offline reading.`);
  }

  const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] };
  const text = body.candidates?.[0]?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? "").join("") ?? "";
  let parsed: z.infer<typeof geminiAnswer>;
  try {
    parsed = geminiAnswer.parse(JSON.parse(text));
  } catch {
    return [];
  }

  const seen = new Set<string>();
  return parsed.candidates
    .map((c) => ({
      value: c.value.replace(/\s+/g, "").replace(/[^A-Za-z0-9\-/#.]/g, "").toUpperCase(),
      printedLabel: c.printedLabel?.trim() || null,
      confidence: c.confidence ?? null,
    }))
    .filter((c) => c.value.length >= 3 && c.value.length <= 60 && !seen.has(c.value) && seen.add(c.value))
    .slice(0, 5);
}

// ─── Handlers ───────────────────────────────────────────────────────────

/** Whether the AI reader is configured, so the app can show or hide its button. */
function status(_req: Request, res: Response) {
  res.json({ data: { ai: Boolean(env.GEMINI_API_KEY), model: env.GEMINI_API_KEY ? env.GEMINI_MODEL : null } });
}

async function read(req: Request, res: Response) {
  if (!env.GEMINI_API_KEY) throw new AppError(503, "AI_NOT_CONFIGURED", "AI reading is not set up on the server.");
  const input = readSchema.parse(req.body);
  res.json({ data: { candidates: await askGemini(input), model: env.GEMINI_MODEL } });
}

// The free tier allows only a few requests a minute: share it fairly between users.
const perUser = rateLimit({
  windowMs: 60 * 1000,
  limit: 8,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req) => currentUser(req).id,
  message: { error: { code: "RATE_LIMITED", message: "Too many AI reads. Wait a minute, or use offline reading." } },
});

// ─── Routes ─────────────────────────────────────────────────────────────

export const labelReaderRoutes = Router();
labelReaderRoutes.get("/", status);
labelReaderRoutes.post("/", authorize("ADMIN", "HOD", "TECHNICAL_OFFICER"), perUser, read);
