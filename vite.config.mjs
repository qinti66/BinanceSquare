import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  build: { outDir: "dist/client" },
  optimizeDeps: { include: ["react", "react-dom/client"] },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    allowedHosts: ["localhost", "127.0.0.1", "terminal.local"],
    fs: {
      // Keep Vite's default protections and exclude the local account vault.
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/.data/**"],
    },
    watch: { ignored: ["**/.data/**", "**/artifacts/**"] },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false,
        timeout: 180000,
        proxyTimeout: 180000,
      },
    },
    warmup: { clientFiles: ["./src/main.jsx"] },
  },
  plugins: [react()],
});
