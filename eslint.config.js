'use strict';

/**
 * ESLint flat configuration.
 *
 * Deliberately close to `eslint:recommended` rather than a large opinionated
 * preset: the rules that are on are the ones that catch real defects, not the
 * ones that enforce a house style a reader has to learn before they can read
 * the code.
 */

const js = require('@eslint/js');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'data/**',
      'flows/flows.json',
      'public/**'
    ]
  },

  js.configs.recommended,

  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        performance: 'readonly'
      }
    },
    rules: {
      // An unused argument is often deliberate (Express error handlers need
      // four parameters); an unused *variable* rarely is.
      'no-unused-vars': ['error', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }],
      'no-console': 'error',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-param-reassign': 'error',
      'no-throw-literal': 'error',
      'consistent-return': 'off',
      'max-len': ['warn', { code: 110, ignoreComments: true, ignoreStrings: true, ignoreTemplateLiterals: true }]
    }
  },

  {
    // Tests may reach for Jest globals and longer lines.
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        jest: 'readonly'
      }
    },
    rules: { 'max-len': 'off' }
  },

  {
    // Build tooling and scripts write to stdout by design.
    files: ['tools/**/*.js', 'scripts/**/*.js'],
    rules: { 'no-console': 'off' }
  },

  {
    // The docs site's front-end scripts run in the browser, not in Node.
    files: ['src/docs/assets/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        history: 'readonly',
        EventSource: 'readonly',
        IntersectionObserver: 'readonly',
        URLSearchParams: 'readonly',
        Blob: 'readonly',
        requestAnimationFrame: 'readonly',
        CustomEvent: 'readonly'
      }
    },
    rules: { 'max-len': 'off' }
  },

  {
    // Custom Node-RED nodes are called by the Node-RED runtime with a fixed
    // signature, so an unused argument is the framework's choice, not a defect.
    // A deliberately ignored catch binding still has to be `_`-prefixed.
    files: ['nodes/**/*.js'],
    rules: {
      'no-unused-vars': ['error', {
        args: 'none',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }]
    }
  }
];
