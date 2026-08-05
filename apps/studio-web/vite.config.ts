import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
      "/mcp-api": {
        target: "http://localhost:4200",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/mcp-api/, "/api/admin/mcp"),
      },
      "/mcp": {
        target: "http://localhost:4100",
        changeOrigin: true,
      },
      "/rag-api": {
        target: "http://localhost:4001",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/rag-api/, "/api"),
      },
    },
  },
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./src/test/setup.ts"],
  },
});
