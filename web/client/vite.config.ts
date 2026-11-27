import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const api = process.env.API_ORIGIN ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: api, changeOrigin: false },
      "/__mock": { target: api, changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    target: "es2022",
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
