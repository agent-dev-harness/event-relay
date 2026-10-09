import tsParser from "@typescript-eslint/parser";

export default [
    {
        ignores: ["dist/**"],
    },
    {
        files: ["**/*.ts"],
        languageOptions: {
            parser: tsParser,
        },
    },
];
