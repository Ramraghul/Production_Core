'use strict';

/**
 * Jest configuration.
 *
 * `--runInBand` is set in the npm scripts rather than here: several suites
 * start a real HTTP server and the embedded MQTT broker, and parallel workers
 * would race for port 1883.
 */

module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.js'],
  collectCoverageFrom: [
    'src/**/*.js',
    'nodes/**/*.js',
    '!src/index.js',
    '!src/docs/assets/**',
    '!**/node_modules/**'
  ],
  coverageThreshold: {
    // The domain core is the part that must stay correct, so it carries the
    // higher bar. The wiring layers are covered by the API and node suites.
    global: { statements: 55, branches: 45, functions: 55, lines: 55 },
    './src/core/': { statements: 85, branches: 75, functions: 85, lines: 85 }
  },
  coverageReporters: ['text-summary', 'lcov'],
  setupFilesAfterEnv: ['<rootDir>/test/setup.js'],
  testTimeout: 30000,
  clearMocks: true,
  verbose: false
};
