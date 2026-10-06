import js from '@eslint/js'
import prettier from 'eslint-config-prettier/flat'
import globals from 'globals'

export default [
  {
    ignores: [
      'dist/**',
      '.cache/**',
      '.npm/**',
      '.yarn/**',
      '.browser-profiles/**',
      'test-results/**',
      'playwright-report/**',
      'coverage/**'
    ]
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    rules: {
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  },
  {
    files: ['*.mjs', 'scripts/**/*.mjs', 'tests/**/*.mjs'],
    languageOptions: { globals: globals.node }
  },
  { files: ['extension/**/*.js', 'tests/**/*.mjs'], languageOptions: { globals: globals.browser } },
  prettier,
  { rules: { curly: ['error', 'all'] } }
]
