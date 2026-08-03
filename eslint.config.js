import tseslint from "typescript-eslint";
import looping from "@loopingai/core/eslint";

const LINTED_FILES = ["src/**/*.ts", "test/**/*.ts"];

export default tseslint.config(
  {
    extends: [...tseslint.configs.recommended],
    files: LINTED_FILES,
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "no-unused-expressions": "off",
      // The Agents SDK's `this.sql`…`` statements are tagged templates run for
      // their side effect (CREATE TABLE / INSERT); keep the rule for everything
      // else.
      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowTaggedTemplates: true }
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ]
    }
  },
  {
    // The rule that keeps each agent's module graph its own. An agent may import
    // core, the plugins it installs, and its own directory — never a sibling
    // agent's internals. Without it, one convenience import quietly puts
    // arc-agi in the proactive bundle and `npm run verify:isolation` starts
    // failing in CI with no obvious cause.
    //
    // `reactive/turn.ts` is the deliberate exception: arc-player is reactive's
    // loop with a different soul, and sharing it is the point. It is imported by
    // path from arc-player, which this allows and a sibling-wide ban would not.
    files: ["src/agents/proactive/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/agents/reactive/*",
                "@/agents/arc-player/*",
                "@loopingai/plugins/arc-agi"
              ],
              message:
                "The proactive agent must not reach into another agent's modules — that is what " +
                "puts their plugins in its bundle. Anything genuinely shared belongs in src/config.ts."
            }
          ]
        }
      ]
    }
  },
  {
    // Type-aware pass — enables @deprecated detection without switching the
    // whole config to recommendedTypeChecked and its stricter rule set.
    files: LINTED_FILES,
    plugins: { "@typescript-eslint": tseslint.plugin, looping },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-deprecated": "error",
      // Covers the object-literal keys `no-deprecated` structurally cannot see —
      // i.e. every `generateText({ system: … })`-style options bag.
      "looping/no-deprecated-object-properties": "error"
    }
  },
  {
    ignores: [
      "worker-configuration.d.ts",
      "node_modules/",
      ".wrangler/",
      "dist/"
    ]
  }
);
