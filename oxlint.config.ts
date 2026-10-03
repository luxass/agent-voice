import { defineConfig } from "oxlint";

export default defineConfig({
  options: {
    typeAware: true,
    typeCheck: true,
  },
  plugins: ["unicorn", "typescript", "oxc"],
  categories: {
    correctness: "error",
    perf: "error",
    suspicious: "error",
    pedantic: "warn",
  },
  rules: {
    "eslint/no-await-in-loop": "off",
    "eslint/require-await": "off",
    "no-console": ["error", { allow: ["error"] }],
    "no-shadow": "off",
    "eslint/eqeqeq": ["warn", "always", { null: "ignore" }],
    "typescript/no-explicit-any": "error",
    "typescript/no-unnecessary-boolean-literal-compare": "off",
    "typescript/prefer-readonly-parameter-types": "off",
    "typescript/no-unsafe-type-assertion": "off",
    curly: "off",
    "typescript/switch-exhaustiveness-check": [
      "warn",
      { considerDefaultExhaustiveForUnions: true },
    ],
  },
  overrides: [
    {
      files: ["src/recording.ts", "src/transcription.ts"],
      rules: {
        // Keep session state and its handlers in the same factory.
        "max-lines-per-function": ["warn", { max: 150 }],
      },
    },
    {
      files: ["test/**/*"],
      rules: {
        "max-lines-per-function": "off",
        "max-lines": "off",
        "max-classes-per-file": "off",
      },
    },
    {
      files: [".github/**/*", "scripts/**/*"],
      rules: {
        "no-console": "off",
      },
    },
  ],
});
