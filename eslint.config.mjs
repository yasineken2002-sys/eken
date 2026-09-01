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
      // `.proof-*/` är gitignorerade engångssonder (rot-.gitignore rad 50).
      // Flat config läser INTE .gitignore, så utan raden här skulle `eslint .`
      // dra in dem. Samma avgränsning som tsconfig.typecheck.json gör.
      '**/.proof-*/**',
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
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
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
  {
    // ── ADMIN RENDERAR OGRANSKAD TEXT — DEN MÅSTE FORTSÄTTA ESCAPAS (#612) ──
    //
    // `ErrorLog.message`, `.stack` och `.context` är ostrukturerad text som
    // kommer ur kastade fel, och admin visar dem på tre ställen (`ErrorsPage`,
    // `OrganizationDetailPage`, dashboardens flöde). I dag renderas de som
    // JSX-BARN, alltså escapade — uppmätt i #612 PR A, där svepet efter
    // `dangerouslySetInnerHTML`, `.innerHTML`, `outerHTML`, `insertAdjacentHTML`
    // och `document.write` över apps/{web,admin,portal}/src gav NOLL träffar.
    //
    // Den mätningen är sann en gång. Regeln nedan gör den durabel: utan den vore
    // nästa `dangerouslySetInnerHTML` i admin en tyst regression, och
    // `apps/admin` har varken vitest eller jest (package.json: dev, build,
    // preview, lint, typecheck) — det finns alltså ingen testväg som skulle
    // kunna fånga den. ESLint är den enda durabla formen som är tillgänglig här.
    //
    // VARFÖR INTE `react/no-danger`: det kräver `eslint-plugin-react`, som inte
    // finns i repot. `no-restricted-syntax` är mekanismen konfigurationen redan
    // använder (DTO-regeln ovan), kostar inget nytt beroende och täcker dessutom
    // DOM-vägarna som `react/no-danger` inte ser.
    //
    // Selektorerna är prövade åt båda hållen: de fäller de fyra skrivande
    // formerna och är tysta på ett JSX-textbarn OCH på en LÄSNING av
    // `el.innerHTML` (bara tilldelning matchas). Se PR-texten.
    files: ['apps/admin/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
          message:
            'Admin visar ogranskad feltext (ErrorLog.message/stack/context). Rendera som JSX-barn så React escapar — dangerouslySetInnerHTML gör den texten körbar (#612).',
        },
        {
          selector:
            'AssignmentExpression > MemberExpression[property.name=/^(innerHTML|outerHTML)$/]',
          message:
            'Tilldelning till innerHTML/outerHTML kringgår React:s escaping. Använd textContent eller rendera via JSX (#612).',
        },
        {
          selector: 'CallExpression > MemberExpression[property.name="insertAdjacentHTML"]',
          message:
            'insertAdjacentHTML tolkar strängen som HTML. Använd textContent eller rendera via JSX (#612).',
        },
      ],
    },
  },
]
