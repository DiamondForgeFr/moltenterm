// The Claude Code part of test-band, a MoltenTerm mod. It watches the Bash calls of the session, keeps the last test
// run, draws it in a band above the prompt, and on a failure asks MoltenTerm to show the output next to the terminal
// by running `molten test-results show` (the MoltenTerm part, main.js). `molten` is found because Claude Code inherits
// the environment of the MoltenTerm terminal it runs in.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { TestRun } from '../types'

const TEST_COMMAND =
  /(^|[\s;&|(])(npm (run )?test|npx (vitest|jest)|vitest|jest|yarn test|pnpm test|go test|pytest|cargo test|task test)\b/

// The output tail sent to MoltenTerm: the failures are at the end of most runners' output.
const TAIL_LINES = 200

const last = atom({ plugin: 'test-band', key: 'last' } as const, null)

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || !TEST_COMMAND.test(e.command)) {
      return ran
    }
    const run: TestRun = { command: e.command.trim().slice(0, 80), failed: ran.isError === true }
    await update($, last, () => run)
    if (run.failed) {
      const tail = (ran.text ?? '').split('\n').slice(-TAIL_LINES).join('\n')
      try {
        const shown = await $.process.run(['molten', 'test-results', 'show', '--title', `Failed: ${run.command}`], {
          stdin: tail,
          timeoutMs: 15000,
        })
        if (shown.exitCode !== 0) {
          $.ui.toast(`test-band: molten test-results show exited with ${shown.exitCode}; is the mod enabled?`)
        }
      } catch {
        $.ui.toast('test-band: molten is not reachable: start Claude Code in a MoltenTerm terminal')
      }
    }
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const run = await read($, last)
    if (run === null || e.props.hasSurvey) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text color={run.failed ? 'red' : 'green'}>{run.failed ? 'Tests failed: ' : 'Tests passed: '}</Text>
        <Text dimColor>{run.command}</Text>
      </Box>
    )
  })
}
