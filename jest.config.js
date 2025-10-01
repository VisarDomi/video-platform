// jest.config.js

export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  clearMocks: true,

  // Add this line. It's the key to making mocks reliable between test files.
  resetModules: true,

  setupFilesAfterEnv: ['<rootDir>/tests/jest.setup.ts'],

  transform: {
    '^.+\\.[tj]sx?$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transformIgnorePatterns: [
    '<rootDir>/node_modules/(?!(p-limit|yocto-queue|p-timeout))',
  ],
};