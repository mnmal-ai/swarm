module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  // .test.mjs files are ES modules (the Lambda is one); the test script
  // runs Node with --experimental-vm-modules so Jest can load them.
  testMatch: ['**/*.test.ts', '**/*.test.mjs'],
  // The Lambda's AWS SDK imports resolve to in-memory fakes in tests, so no
  // test needs the Lambda's own dependencies installed or reaches AWS.
  moduleNameMapper: {
    '^@aws-sdk/(.*)$': '<rootDir>/test/fakes/aws-sdk/$1.mjs',
  },
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  },
  setupFilesAfterEnv: ['aws-cdk-lib/testhelpers/jest-autoclean'],
};
