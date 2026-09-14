import { z } from "zod";
import { defineConfig } from "./load";

/** Everything all three processes need to agree on. */
export const sharedSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  /** Goes into every structured log line and every audit record. */
  SERVICE_NAME: z.string().trim().default("scriptoria"),
});

export const loadSharedConfig = defineConfig("shared", sharedSchema);
export type SharedConfig = z.infer<typeof sharedSchema>;
