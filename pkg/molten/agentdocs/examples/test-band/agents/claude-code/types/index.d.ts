export type TestRun = { command: string; failed: boolean }

declare module 'claude-code' {
  interface PluginState {
    'test-band': { last: TestRun | null }
  }
}
