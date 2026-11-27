import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load `.env` from the current directory, the server folder or the workspace root (web/.env).
 * Real environment variables always win. Returns the file that was loaded, if any.
 */
export function loadDotEnv(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/lib or dist/lib → server → web
  const candidates = [resolve(process.cwd(), ".env"), resolve(here, "../../.env"), resolve(here, "../../../.env")];
  for (const file of new Set(candidates)) {
    if (existsSync(file)) {
      process.loadEnvFile(file);
      return file;
    }
  }
  return undefined;
}
