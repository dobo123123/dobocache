import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["temp/**", "node_modules/**", "dist/**", "archive/**"],
  },
});
