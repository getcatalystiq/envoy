import { z } from "zod";

const envSchema = z
  .object({
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    JWT_SECRET: z
      .string()
      .min(32, "JWT_SECRET must be at least 32 characters"),
    NEXT_PUBLIC_URL: z.string().url("NEXT_PUBLIC_URL must be a valid URL"),
    ENVIRONMENT: z.enum(["dev", "staging", "prod"]).default("dev"),
    CRON_SECRET: z.string().optional(),
    SES_ACCESS_KEY_ID: z.string().min(1, "SES_ACCESS_KEY_ID is required"),
    SES_SECRET_ACCESS_KEY: z
      .string()
      .min(1, "SES_SECRET_ACCESS_KEY is required"),
    AWS_SES_REGION: z.string().default("us-east-1"),
    // Claude Managed Agents. The SDK reads ANTHROPIC_API_KEY from env itself;
    // validating here keeps the fail-fast behavior the old TWIN_API_KEY had.
    ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
    // Default Managed Agents environment used when an org leaves environment_id
    // blank. Required outside dev (see superRefine) — environment_id is a
    // required input to sessions.create, so a null fallback would 503 every org.
    ANTHROPIC_DEFAULT_ENVIRONMENT_ID: z.string().optional(),
    SES_NOTIFICATION_TOPIC_ARN: z.string().optional(),
    ALLOWED_DCR_DOMAINS: z
      .string()
      .default("claude.ai,chatgpt.com,localhost,127.0.0.1")
      .transform((s) => s.split(",").map((d) => d.trim())),
  })
  .superRefine((data, ctx) => {
    if (data.ENVIRONMENT !== "dev" && !data.ANTHROPIC_DEFAULT_ENVIRONMENT_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ANTHROPIC_DEFAULT_ENVIRONMENT_ID"],
        message:
          "ANTHROPIC_DEFAULT_ENVIRONMENT_ID is required outside dev (environment_id is required by sessions.create)",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

/**
 * Lazily validated environment — crashes on first access if invalid.
 * Lazy to avoid crashing during Next.js build (no env vars at build time).
 */
export function getEnv(): Env {
  if (!_env) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      const errors = result.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new Error(`Environment validation failed:\n${errors}`);
    }
    _env = result.data;
  }
  return _env;
}
