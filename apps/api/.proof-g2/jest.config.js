module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: __dirname,
  testRegex: '.*\\.e2e\\.ts$',
  moduleFileExtensions: ['ts', 'tsx', 'js'],
  testTimeout: 180000,
  transform: {
    '^.+\\.(t|j)sx?$': [
      'ts-jest',
      {
        tsconfig: {
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          esModuleInterop: true,
          target: 'ES2022',
          module: 'CommonJS',
          jsx: 'react-jsx',
        },
      },
    ],
  },
}
