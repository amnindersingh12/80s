import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { loadDotEnv } from "./lib/env.js";
import { createServices } from "./services.js";

async function main(): Promise<void> {
  loadDotEnv();
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const services = await createServices(config);
  const app = await buildApp({ config, services, logger: true });
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
    const force = setTimeout(() => process.exit(1), 10_000);
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
