import { z } from "zod";
import { PASSWORD_RULES } from "../../utils/password.js";

export const passwordSchema = z
  .string()
  .min(PASSWORD_RULES.minLength, PASSWORD_RULES.message)
  .max(PASSWORD_RULES.maxLength, PASSWORD_RULES.message)
  .regex(PASSWORD_RULES.pattern, PASSWORD_RULES.message);

export const loginSchema = z.object({
  email: z.email().max(254).transform((email) => email.toLowerCase()),
  // No strength rules here: only check presence and an upper bound (hashing cost).
  password: z.string().min(1).max(PASSWORD_RULES.maxLength),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_RULES.maxLength),
  newPassword: passwordSchema,
});

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
