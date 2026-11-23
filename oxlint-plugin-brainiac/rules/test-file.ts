/** Whether a rule is linting a test file (`*.test.ts`, `*.browser.test.tsx`, ...). */
export const isTestFile = (filename: string) => /\.test\.[cm]?[jt]sx?$/.test(filename);
