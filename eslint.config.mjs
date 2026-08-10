import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      '**/node_modules/**',
      'packages/cli/vendor/**',
      // Runner-generated output; fixtures may intentionally violate lint rules.
      'evals/.runs/**',
      'evals/.staging/**',
      'evals/staging/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['packages/cli/**/*.{js,mjs}', 'scripts/**/*.{js,mjs}', 'evals/**/*.{js,mjs}', 'eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      'no-regex-spaces': 'off',
    },
  },
];
