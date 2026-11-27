import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), "utf8");

/** Every env var the config parser reads, extracted from the source. */
function configVars(): string[] {
  const src = read("../src/config.ts");
  const names = [...src.matchAll(/r\.(?:str|def|int|bool|url|path|json|list|query|oneOf)\(\s*"([A-Z0-9_]+)"/g)].map((m) => m[1]!);
  return [...new Set(names)].sort();
}

describe("documentation", () => {
  const vars = configVars();

  it("finds the config variables", () => {
    expect(vars.length).toBeGreaterThan(50);
    expect(vars).toContain("MEDIA_API_BASE");
  });

  it("documents every variable in .env.example", () => {
    const example = read("../../.env.example");
    const missing = vars.filter((v) => !new RegExp(`^${v}=`, "m").test(example));
    expect(missing).toEqual([]);
  });

  it("documents every variable in README.md", () => {
    const readme = read("../../README.md");
    expect(vars.filter((v) => !readme.includes(`\`${v}\``) && !readme.includes(`${v}\``))).toEqual([]);
  });

  it(".env.example loads as a valid (demo) configuration", () => {
    const env: Record<string, string> = {};
    for (const line of read("../../.env.example").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]!] = m[2]!.replace(/\s+#.*$/, "").trim();
    }
    const config = loadConfig(env);
    expect(config.demo).toBe(true);
    expect(config.remote).toBeUndefined();
  });
});
