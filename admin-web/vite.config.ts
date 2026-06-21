import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// admin-web/ 与 admin-server/ 同级；构建产物输出到 admin-server/public/，由 Express 静态托管于根路径 /。
// dev 时 /api 代理到本地 Express(18790)。
export default defineConfig({
  base: "/",
  plugins: [react()],
  build: {
    outDir: "../admin-server/public",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:18790",
    },
  },
});
