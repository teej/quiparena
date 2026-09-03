import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const serverPort = Number(process.env["PORT"] ?? 8787);

export default defineConfig({
  root: "client",
  plugins: [react()],
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": `http://127.0.0.1:${serverPort}`,
      "/ingest": {
        target: `ws://127.0.0.1:${serverPort}`,
        ws: true,
      },
    },
  },
});
