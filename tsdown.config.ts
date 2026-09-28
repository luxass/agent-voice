import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/index.ts"],
  format: ["cjs", "esm"],
  clean: true,
  dts: true,
  treeshake: true,
  exports: {
    enabled: "local-only",
  },
  publint: true,
});
