import { buildApp } from "./app.js";
import { ConfigError, loadConfigWithFallback, type Env } from "./config.js";
import { mask } from "./doctor.js";
import { applyDiscovery, discoverFrontend, needsDiscovery, type DiscoveryResult } from "./lib/discovery.js";
import { loadDotEnv } from "./lib/env.js";
import { createServices } from "./services.js";

/** One-time MEDIA_FRONTEND_URL scan (kept in memory for the dyno's lifetime). */
async function discover(): Promise<{ env: NodeJS.ProcessEnv; discovery?: DiscoveryResult; filled: string[] }> {
  if (!needsDiscovery(process.env)) return { env: process.env, filled: [] };
  const frontend = process.env.MEDIA_FRONTEND_URL!.trim();
  const discovery = await discoverFrontend(frontend);
  const { env, filled } = applyDiscovery(process.env, discovery);
  console.log(
    JSON.stringify({
      level: 30,
      msg: "MEDIA_FRONTEND_URL discovery",
      frontend,
      filled,
      supabaseUrl: discovery.supabaseUrl,
      anonKey: discovery.anonKey ? mask(discovery.anonKey) : undefined,
      apiBase: discovery.apiBase,
      apiBaseSource: discovery.apiBaseSource,
      scanned: discovery.scanned.length,
      errors: discovery.errors.slice(0, 5),
      ms: discovery.durationMs,
    }),
  );
  return { env, discovery, filled };
}

async function main(): Promise<void> {
  loadDotEnv();
  let env: Env = process.env;
  let discovery: { result: DiscoveryResult; filled: string[] } | undefined;
  try {
    const d = await discover();
    env = d.env;
    if (d.discovery) discovery = { result: d.discovery, filled: d.filled };
  } catch (err) {
    // Discovery must never keep the dyno from binding $PORT.
    console.error(JSON.stringify({ level: 50, msg: "MEDIA_FRONTEND_URL discovery failed", err: String(err) }));
  }

  let boot;
  try {
    boot = loadConfigWithFallback(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  let { config, problems } = boot;
  let services;
  try {
    services = await createServices(config);
  } catch (err) {
    // Same rule for provider wiring errors: report, don't crash-loop.
    problems = [...problems, `Media provider failed to start: ${err instanceof Error ? err.message : String(err)}`];
    config = loadConfigWithFallback({ ...env, MEDIA_API_BASE: "", SUBSONIC_URL: "", DEMO_MODE: "true" }).config;
    services = await createServices(config);
  }
  if (problems.length) {
    console.error(
      JSON.stringify({ level: 50, msg: "Invalid media configuration — started in safe demo mode; see /api/health and /api/doctor", problems }),
    );
  }
  const app = await buildApp({ config, services, logger: true, env: process.env, discovery, configErrors: problems });
  // Re-wire service warnings into the app logger now that it exists.
  const address = await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      providers: services.chain.health().map((p) => `${p.role}:${p.name}`),
      cache: services.cache.kind,
      demo: config.demo,
      recommendations: services.engine.enabledSources,
    },
    `80s web player listening on ${address}`,
  );
  if (config.demo) app.log.warn("DEMO MODE: no media server configured — serving synthetic clips. Set MEDIA_API_BASE to connect.");

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received, shutting down`);
    // Heroku sends SIGTERM and SIGKILLs 30 s later: finish in-flight streams within 25 s.
    const force = setTimeout(() => {
      app.log.warn("shutdown took longer than 25 s, forcing exit");
      process.exit(1);
    }, 25_000);
    force.unref();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
