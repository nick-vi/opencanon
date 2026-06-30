import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".claude/**", ".opencode/**", ".opencanon/**", "tmp/**"],
    setupFiles: ["./tests/setup-vitest.ts"],
  },
});
