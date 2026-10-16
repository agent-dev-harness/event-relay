import tsParser from "@typescript-eslint/parser";

export default [
    {
        ignores: ["dist/**", ".claude/workflows/**"],
    },
    {
        files: ["**/*.ts"],
        languageOptions: {
            parser: tsParser,
        },
    },
];
