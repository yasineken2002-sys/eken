import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/coverage/**',
      '**/.vite/**',
      '**/prisma/seed.ts',
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs['recommended'].rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['apps/api/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
      // NestJS DTO:er måste importeras som VÄRDEN — `import type` raderas vid
      // kompilering så reflect-metadata försvinner och ValidationPipe tappar
      // alla class-validator-constraints (CLAUDE.md "DTO-regel (kritisk)").
      // Regeln gäller per namnkonvention: alla specifiers som slutar på `Dto`.
      // Fångar både `import type { XDto }` och `import { type XDto }`.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportDeclaration[importKind="type"] > ImportSpecifier[imported.name=/Dto$/]',
          message:
            'DTO:er måste importeras som värden, inte med `import type` — annars tappar ValidationPipe sin metadata (CLAUDE.md DTO-regel).',
        },
        {
          selector: 'ImportSpecifier[importKind="type"][imported.name=/Dto$/]',
          message:
            'DTO:er måste importeras som värden, inte med `import { type ... }` — annars tappar ValidationPipe sin metadata (CLAUDE.md DTO-regel).',
        },
      ],
    },
  },
  {
    // Spec-filer behöver bara DTO:er som typannotering på mockar — där är
    // `import type` korrekt och regeln ovan ska inte gälla.
    files: ['apps/api/**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
]
