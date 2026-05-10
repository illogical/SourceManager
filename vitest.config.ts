import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "backend",
          include: ["tests/vitest/**/*.test.ts"],
          environment: "node",
        },
      },
      "./frontend/vitest.config.ts",
    ],
  },
})
