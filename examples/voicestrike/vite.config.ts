import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "@voice-commerce/core": new URL("../../packages/core/src/index.ts", import.meta.url).pathname,
      "@voice-commerce/adapter-agora": new URL("../../packages/adapter-agora/src/index.ts", import.meta.url).pathname,
    },
  },
});
