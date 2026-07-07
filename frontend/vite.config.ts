import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// Build output goes straight into the backend's static dir so FastAPI can
// serve the SPA (one container, one port — §3).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "../backend/static/spa"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8000",
      "/flags": "http://localhost:8000",
      "/healthz": "http://localhost:8000",
    },
  },
});
