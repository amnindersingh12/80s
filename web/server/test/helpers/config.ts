import { loadConfig, type Config, type Env, type RemoteProviderConfig } from "../../src/config.js";

/** Env for a RemoteMediaProvider pointed at the fake upstream, with fast test timings. */
export function remoteEnv(base: string, extra: Env = {}): Env {
  return {
    MEDIA_API_BASE: base,
    SUPABASE_URL: base,
    SUPABASE_ANON_KEY: "anon-key",
    MEDIA_USER_EMAIL: "me@example.com",
    MEDIA_USER_PASSWORD: "pw",
    MEDIA_REQUEST_TIMEOUT_MS: "300",
    MEDIA_JOB_POLL_INTERVAL_MS: "20",
    MEDIA_JOB_MAX_WAIT_MS: "600",
    MEDIA_JOB_QUEUE_TIMEOUT_MS: "2000",
    LISTENBRAINZ_ENABLED: "false",
    MUSICBRAINZ_ENABLED: "false",
    ...extra,
  };
}

export function remoteConfig(base: string, extra: Env = {}): { config: Config; remote: RemoteProviderConfig } {
  const config = loadConfig(remoteEnv(base, extra));
  if (!config.remote) throw new Error("remote config missing");
  return { config, remote: config.remote };
}

/** Demo-mode config with all external recommendation sources off. */
export function demoConfig(extra: Env = {}): Config {
  return loadConfig({ DEMO_MODE: "true", LISTENBRAINZ_ENABLED: "false", MUSICBRAINZ_ENABLED: "false", ...extra });
}
