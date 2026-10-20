import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { projectHash } from './shared'

// The handoff cycle: Traspaso -> (checkpoint turn) -> Limpiar y seguir -> /clear.
// The hooks registered with `on` stand for the engine and the disk beneath the
// plugin; `pending` is what the continuity folder holds at each step.

const BAND = {
  plugin: 'quota-guardian-bar',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const
const ROOT = 'C:/home/.claude/session-continuity'

// The engine hands paths over in the platform's own form (backslashes on Windows).
const slashes = (p: string): string => p.split(String.fromCharCode(92)).join('/')

type Pending = { consumed: boolean; checkpointFile: string | null; mtimeMs: number } | null

type Disk = { pending: Pending; ran: string[]; shared?: { hash: string; json: object; transcriptMtime?: number } }

function engine(on: On, state: Disk) {
  on('env.get', (_, e) => ({ value: e.name === 'USERPROFILE' ? 'C:/home' : undefined }))
  on('fs.read', (_, e) => {
    if (slashes(e.path) === `${ROOT}/pending-dir/pending.json` && state.pending !== null) {
      return { value: JSON.stringify({ consumed: state.pending.consumed, checkpointFile: state.pending.checkpointFile }) }
    }

    if (state.shared !== undefined && slashes(e.path) === `${ROOT}/${state.shared.hash}/state.json`) {
      return { value: JSON.stringify(state.shared.json) }
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
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: 's1' }))
  on('fs.stat', (_, e) => {
    if (state.shared?.transcriptMtime !== undefined && slashes(e.path) === 'C:/home/t.jsonl') {
      return { value: { kind: 'file', size: 1, mtimeMs: state.shared.transcriptMtime, isLink: false } }
    }

    throw new Error('ENOENT')
  })
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

async function startWithUsage($: Engine) {
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

test("the folder hash matches Guardian's lib/paths.js projectHash", async () => {
  // reference values from lib/paths.js projectHash on Windows (absolute paths,
  // which Claude Code always hands both the hooks and the bar)
  const sep = String.fromCharCode(92)
  expect(await projectHash(['C:', 'Users', 'Lonardo Antonilez', 'Documents'].join(sep))).toBe('ea61dc111ceb')
  expect(await projectHash(['C:', 'Users', 'Lonardo Antonilez', 'Documents', 'claude-quota-guardian'].join(sep))).toBe(
    'ba4f3a9c3c5f',
  )
})

test("the session's shared answer wins: an API-key session shows 5 min even if the engine reports rate limits", async ($, on) => {
  engine(on, {
    pending: null,
    ran: [],
    shared: {
      hash: await projectHash('/'),
      json: { sessionId: 's1', subscription: false, subscriptionFrom: 'api-env', lastActivityAt: new Date().toISOString() },
    },
  })
  await startWithUsage($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Caché [0-9]+ min/ }))?.text).toBe('Caché 5 min')
  await ui.unmount()
})

test("a false that is not an API setting does not beat the engine's rate limits", async ($, on) => {
  engine(on, {
    pending: null,
    ran: [],
    shared: {
      hash: await projectHash('/'),
      json: { sessionId: 's1', subscription: false, subscriptionFrom: 'no-login', lastActivityAt: new Date().toISOString() },
    },
  })
  await startWithUsage($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Caché [0-9]+ min/ }))?.text).toBe('Caché 60 min')
  await ui.unmount()
})

test('the bar counts from the shared activity like the host: max(lastActivityAt, transcript mtime)', async ($, on) => {
  const twentyAgo = Date.now() - 20 * 60_000
  engine(on, {
    pending: null,
    ran: [],
    shared: {
      hash: await projectHash('/'),
      json: {
        sessionId: 's1',
        subscription: true,
        subscriptionFrom: 'login',
        lastActivityAt: new Date(twentyAgo - 5 * 60_000).toISOString(),
        transcriptPath: 'C:/home/t.jsonl',
      },
      transcriptMtime: twentyAgo,
    },
  })
  // no turn in this conversation yet: only the shared answer can give 40
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.measure({ context: { tokens: 20_000, window: 1_000_000, percent: 2 }, rateLimits: [], changed: [] })

  // lib/cache-clock.js cacheStatus on the same inputs: ceil((twentyAgo + 60 min - now) / 1 min) = 40
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Caché [0-9]+ min/ }))?.text).toBe('Caché 40 min')
  await ui.unmount()
})

test("another session's state in the same folder is ignored", async ($, on) => {
  engine(on, {
    pending: null,
    ran: [],
    shared: { hash: await projectHash('/'), json: { sessionId: 'other', subscription: false, lastActivityAt: new Date().toISOString() } },
  })
  await startWithUsage($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Caché [0-9]+ min/ }))?.text).toBe('Caché 60 min')
  await ui.unmount()
})

test('after /clear the old countdown is gone (no session.start fires for it)', async ($, on) => {
  engine(on, { pending: null, ran: [] })
  await startWithUsage($)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Caché/ })).toBeUndefined()
  await ui.unmount()
})
