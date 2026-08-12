/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.spec.ts'],

  // Clears the test database once, before any worker starts. Doing this per-file would
  // let one parallel worker wipe rows another was using.
  globalSetup: '<rootDir>/test/globalSetup.ts',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/index.ts', '!src/**/*.d.ts'],
  coverageDirectory: 'coverage',

  // The safety layer is the one component that must never regress. Every branch of the
  // red-flag matcher, the negation guard, the distress detector and the urgency ratchet
  // is exercised by test/unit/safety. See IMPLEMENTATION_PLAN.md sections 9 and 14.
  coverageThreshold: {
    'src/safety/**/*.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },

  clearMocks: true,
  restoreMocks: true,
  verbose: false,
};
