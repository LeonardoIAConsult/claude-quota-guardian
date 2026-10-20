import { expect, test } from 'claude-code/testing'

// The handoff cycle: Traspaso -> (checkpoint turn) -> Limpiar y seguir -> /clear.
// The hooks registered with `on` stand for the engine and the disk beneath the
// plugin; `pending` is what the continuity folder holds at each step.

const BAND = { plugin: 'quota-guardian-bar', component: 'AbovePrompt', props: { hasSurvey: false } } as const
const ROOT = 'C:/home/.claude/session-continuity'

// The engine hands paths over in the platform's own form (backslashes on Windows).
const slashes = (p: string): string => p.split(String.fromCharCode(92)).join('/')

type Pending = { consumed: boolean; checkpointFile: string | null; mtimeMs: number } | null

function engine(on: Parameters<Parameters<typeof test>[1]>[1], state: { pending: Pending; ran: string[] }) {
  on('env.get', (_, e) => ({ value: e.name === 'USERPROFILE' ? 'C:/home' : undefined }))
  on('fs.read', (_, e) => {
    if (slashes(e.path) === `${ROOT}/pending-dir/pending.json` && state.pending !== null) {
      return { value: JSON.stringify({ consumed: state.pending.consumed, checkpointFile: state.pending.checkpointFile }) }
    }

    // no config.json: the bar falls back to its defaults
    throw new Error('ENOENT')
  })
  on('fs.list', (_, e) => {
    if (slashes(e.path) === ROOT) {
      return { value: [{ name: 'pending-dir', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
    }

    return {
      value:
        state.pending === null
          ? []
          : [{ name: 'pending.json', kind: 'file', size: 10, mtimeMs: state.pending.mtimeMs, isLink: false }],
    }
  })
  on('command.list', () => ({
    value: [{ name: 'continuity-checkpoint', description: 'checkpoint', source: 'user' }],
  }))
  on('command.run', (_, e) => {
    state.ran.push(e.command)

    return { text: '' }
  })
  on('prompt.submit', () => ({ drop: 'test' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('clock.now', () => ({ value: Date.now() }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  // the engine's own band beneath the plugin
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
}

async function startWithUsage($: Parameters<Parameters<typeof test>[1]>[0]) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.measure({
    context: { tokens: 150_000, window: 1_000_000, percent: 15 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 40 }],
    changed: [],
  })
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
}

test('the countdown shows a subscription ttl after the first turn', async ($, on) => {
  engine(on, { pending: null, ran: [] })
  await startWithUsage($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Caché 60 min/ }))?.text).toBe('Caché 60 min')
  await ui.unmount()
})

test('Limpiar y seguir never appears, and /clear never runs, without a fresh unconsumed checkpoint', async ($, on) => {
  const state: { pending: Pending; ran: string[] } = {
    // a leftover from an earlier resume: consumed, so the next session would ignore it
    pending: { consumed: true, checkpointFile: 'C:/home/old.md', mtimeMs: Date.now() + 5_000 },
    ran: [],
  }
  engine(on, state)
  await startWithUsage($)

  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'handoff' })
  await ui.unmount()
  expect(state.ran).toEqual(['continuity-checkpoint'])

  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'clear' })).toBeUndefined()
  expect(await ui.find({ key: 'handoff' })).toBeDefined()
  await ui.unmount()
  expect(state.ran).toEqual(['continuity-checkpoint'])
})

for (const [name, pending] of [
  // an unconsumed pending from an earlier handoff: /clear would drop newer work
  ['older than the handoff', { consumed: false, checkpointFile: 'C:/home/old.md', mtimeMs: Date.now() - 60_000 }],
  ['naming no checkpoint file', { consumed: false, checkpointFile: null, mtimeMs: Date.now() + 5_000 }],
] as const) {
  test(`a pending ${name} never offers Limpiar y seguir`, async ($, on) => {
    const state: { pending: Pending; ran: string[] } = { pending: { ...pending }, ran: [] }
    engine(on, state)
    await startWithUsage($)

    let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'handoff' })
    await ui.unmount()
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })

    ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ key: 'clear' })).toBeUndefined()
    await ui.unmount()
    expect(state.ran).toEqual(['continuity-checkpoint'])
  })
}

test('a fresh checkpoint turns the button into Limpiar y seguir, which runs /clear', async ($, on) => {
  const state: { pending: Pending; ran: string[] } = { pending: null, ran: [] }
  engine(on, state)
  await startWithUsage($)

  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'handoff' })
  await ui.unmount()

  state.pending = { consumed: false, checkpointFile: 'C:/home/new.md', mtimeMs: Date.now() + 5_000 }
  await $.turn.complete({ answer: 'saved', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })

  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'clear' })
  await ui.unmount()
  expect(state.ran).toEqual(['continuity-checkpoint', 'clear'])
})

test('a new session forgets the old countdown and any handoff in flight', async ($, on) => {
  const state: { pending: Pending; ran: string[] } = { pending: null, ran: [] }
  engine(on, state)
  await startWithUsage($)

  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'handoff' })
  await ui.unmount()
  state.pending = { consumed: false, checkpointFile: 'C:/home/new.md', mtimeMs: Date.now() + 5_000 }
  await $.turn.complete({ answer: 'saved', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })

  // the person runs /clear by hand: a new session starts, Guardian resumes it
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { tokens: 20_000, window: 1_000_000, percent: 2 }, rateLimits: [], changed: [] })

  ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'clear' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Caché/ })).toBeUndefined()
  await ui.unmount()
})
