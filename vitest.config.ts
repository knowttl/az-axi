import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: configDefaults.include.map((pattern) => `test/${pattern}`),
    maxWorkers: 2,
  },
});
