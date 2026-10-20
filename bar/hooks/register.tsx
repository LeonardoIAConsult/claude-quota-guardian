import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheConfig, Usage } from '../types'
import { currentFolder, readShared, subscriptionOf } from './shared'

// The bar above the prompt: prompt-cache countdown, context size, 5h / week,
// and a one-click handoff through Guardian's /continuity-checkpoint. After the
// checkpoint, "Limpiar y seguir" runs /clear; Guardian's SessionStart hook then
// loads the checkpoint into the fresh session by itself.
//
// The minutes come from the session's state.json (./shared.ts), the same
// lastActivityAt and subscription the status line and the extension read; the
// bar's own turn end and rate limits only fill in until Guardian's first hook
// has written them. The ttl math mirrors lib/cache-clock.js (a hooks module
// cannot require Node code): change both together.

const SUBSCRIPTION_TTL_MINUTES = 60
const API_TTL_MINUTES = 5
const DEFAULTS: CacheConfig = { enabled: true, ttlMinutes: null, warnMinutes: 5 }

const usage = atom({ plugin: 'quota-guardian-bar', key: 'usage' } as const, null)
const shared = atom({ plugin: 'quota-guardian-bar', key: 'shared' } as const, null)
const config = atom({ plugin: 'quota-guardian-bar', key: 'config' } as const, DEFAULTS)
const lastTurn = atom({ plugin: 'quota-guardian-bar', key: 'lastTurn' } as const, 0)
const now = atom({ plugin: 'quota-guardian-bar', key: 'now' } as const, 0)
const ready = atom({ plugin: 'quota-guardian-bar', key: 'ready' } as const, false)
const waiting = atom({ plugin: 'quota-guardian-bar', key: 'waiting' } as const, false)

const thousands = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

function ttlMinutes(cfg: CacheConfig, subscription: boolean): number {
  if (typeof cfg.ttlMinutes === 'number' && cfg.ttlMinutes > 0) {
    return cfg.ttlMinutes
  }

  return subscription ? SUBSCRIPTION_TTL_MINUTES : API_TTL_MINUTES
}

// Minutes left, rounded up and never above the ttl; 0 means expired.
function minutesLeft(last: number, ttl: number, at: number): number {
  const leftMs = last + ttl * 60_000 - at

  return leftMs <= 0 ? 0 : Math.min(ttl, Math.ceil(leftMs / 60_000))
}

// When the cache was last used: the session's shared answer (state.json plus
// the transcript's mtime, as the status line and the host compute it), or the
// end of the bar's own last main turn when that is newer: the cache was just
// used then, whatever a lagging state.json says. 0 = no activity yet.
function lastActivity(own: number, fromState: number | null | undefined): number {
  return Math.max(own, fromState ?? 0)
}

// A new conversation (start, /clear, /resume) has no cache of its own yet and
// no handoff in flight; the previous one's numbers would mislead.
async function forgetConversation($: EngineInterface): Promise<void> {
  await update($, lastTurn, () => 0)
  await update($, usage, () => null)
  await update($, shared, () => null)
  await update($, ready, () => false)
  await update($, waiting, () => false)
}

// Guardian's own config file, so the bar, the status line and the extension
// share one ttl. Missing or unreadable means the defaults.
function parseConfig(text: string): CacheConfig {
  try {
    const cache = JSON.parse(text)?.cache ?? {}

    return {
      enabled: cache.enabled !== false,
      ttlMinutes: typeof cache.ttlMinutes === 'number' && cache.ttlMinutes > 0 ? cache.ttlMinutes : null,
      warnMinutes:
        typeof cache.warnMinutes === 'number' && cache.warnMinutes >= 0 ? cache.warnMinutes : DEFAULTS.warnMinutes,
    }
  } catch {
    return DEFAULTS
  }
}

// A checkpoint the next session will really load: this project's pending.json
// (the one /continuity-checkpoint writes and hooks/resume-context.js reads),
// written since the handoff started (`since`), not consumed yet, naming its
// checkpoint file. /clear is offered (and run) only when it exists, so the
// button can never wipe a conversation that has nothing to come back to.
async function freshCheckpoint($: EngineInterface, root: string | undefined, since: number): Promise<boolean> {
  if (root === undefined || since === 0) {
    return false
  }

  try {
    // the folder of the cwd now: /continuity-checkpoint writes under process.cwd()
    const folder = await currentFolder($)
    const pending = (await $.fs.list(`${root}/${folder}`)).find(f => f.name === 'pending.json')

    // 2 s of slack between the engine clock and the file system's mtime
    if (pending === undefined || pending.mtimeMs < since - 2000) {
      return false
    }

    const data = JSON.parse(await $.fs.read(`${root}/${folder}/pending.json`))

    return data?.consumed === false && typeof data.checkpointFile === 'string' && data.checkpointFile !== ''
  } catch {
    return false
  }
}

export const register: Register = on => {
  let warned = false
  let ticking = false
  let root: string | undefined
  let handoffAt = 0
  // Bumped whenever a conversation ends or starts: a tick still waiting on the
  // disk from the previous one must not write its numbers into the new one.
  let generation = 0

  on('session.start', async ($, e, next) => {
    const t = await $.clock.now()
    await update($, now, () => t)
    warned = false
    handoffAt = 0
    generation += 1
    await forgetConversation($)

    const home = (await $.env.get('CQG_HOME')) ?? (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    root = home === undefined ? undefined : `${home}/.claude/session-continuity`

    if (root !== undefined) {
      try {
        const text = await $.fs.read(`${root}/config.json`)
        await update($, config, () => parseConfig(text))
      } catch {
        await update($, config, () => DEFAULTS)
      }
    }

    if (!ticking) {
      ticking = true
      $.clock.every(30_000, () => {
        // A tick can outlive its session (it waits on the disk while the
        // session ends): it must never leave a rejection behind.
        void (async () => {
          const started = generation
          const at = await $.clock.now()
          const fromState = await readShared($, root)

          if (started !== generation) {
            return
          }

          await update($, now, () => at)
          await update($, shared, () => fromState)
          const last = lastActivity(await read($, lastTurn), fromState?.lastActivity)
          const cfg = await read($, config)
          const data = await read($, usage)

          if (last === 0 || !cfg.enabled) {
            return
          }

          const left = minutesLeft(last, ttlMinutes(cfg, subscriptionOf(fromState, data?.subscription ?? false)), at)

          if (left > 0 && left <= cfg.warnMinutes && !warned) {
            warned = true
            $.ui.toast(`Al caché le quedan ${left} min. Envía un mensaje para mantenerlo o haz el traspaso.`, {
              timeoutMs: 15_000,
            })
          }
        })().catch(() => undefined)
      })
    }

    return next(e)
  })

  // /clear and /resume carry on in the same process under a new session id,
  // and no session.start fires for them: this is where the old one ends.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      generation += 1
      warned = false
      handoffAt = 0
      await forgetConversation($)
    }

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const windowPct = (kind: string): number | null =>
      e.rateLimits.find(limit => limit.kind === kind)?.percentUsed ?? null
    const fresh: Usage = {
      tokens: e.context.tokens ?? 0,
      percent: e.context.percent ?? 0,
      fiveHour: windowPct('five_hour'),
      week: windowPct('seven_day'),
      usd: e.cost?.usd ?? null,
      subscription: e.rateLimits.length > 0,
    }
    await update($, usage, () => fresh)

    // measure fires after every API response: read the shared answer only
    // while the bar has none yet (the tick and turn.complete keep it fresh)
    if ((await read($, shared)) === null) {
      const fromState = await readShared($, root)
      await update($, shared, () => fromState)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const t = await $.clock.now()
      warned = false
      await update($, lastTurn, () => t)
      await update($, now, () => t)
      const fromState = await readShared($, root)
      await update($, shared, () => fromState)

      // Any main turn can end while a handoff is pending (one already running
      // when Traspaso was pressed, say): only the one that left a checkpoint
      // turns the button into "Limpiar y seguir".
      if ((await read($, waiting)) && (await freshCheckpoint($, root, handoffAt))) {
        await update($, waiting, () => false)
        await update($, ready, () => true)
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const data = await read($, usage)
    const fromState = await read($, shared)
    const cfg = await read($, config)
    const last = lastActivity(await read($, lastTurn), fromState?.lastActivity)
    const at = await read($, now)
    const checkpointReady = await read($, ready)
    const below = await next(e)

    if (e.props.hasSurvey || data === null || !cfg.enabled) {
      return below
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const ttl = ttlMinutes(cfg, subscriptionOf(fromState, data.subscription))
    const left = last === 0 ? null : minutesLeft(last, ttl, at)
    const color = left === null ? 'green' : left === 0 ? 'red' : left <= cfg.warnMinutes ? 'yellow' : 'green'
    const parts = [
      `Contexto ${thousands(data.tokens)} (${data.percent}%)`,
      data.fiveHour === null ? null : `5 h ${data.fiveHour}%`,
      data.week === null ? null : `Semana ${data.week}%`,
      data.usd === null ? null : `Por API US$ ${data.usd.toFixed(2)}`,
    ].filter(part => part !== null)

    const mine = (
      <Box flexDirection="row" gap={2} flexWrap="wrap">
        {left !== null && (
          <Text color={color} bold>
            {left === 0 ? 'Caché vencido' : `Caché ${left} min`}
          </Text>
        )}
        <Text dimColor>{parts.join(' · ')}</Text>
        {left !== null && left <= cfg.warnMinutes && (
          <Text color={color}>
            {left === 0 ? 'El siguiente mensaje vuelve' : 'Si vence, el siguiente mensaje vuelve'} a cobrar{' '}
            {thousands(data.tokens)} tokens
          </Text>
        )}
        {checkpointReady ? (
          <Button
            key="clear"
            label="Limpiar y seguir"
            variant="primary"
            onPress={async () => {
              await update($, ready, () => false)

              if (!(await freshCheckpoint($, root, handoffAt))) {
                handoffAt = 0
                $.ui.toast('No encontré un checkpoint pendiente de cargar, así que no limpié la sesión. Pulsa Traspaso otra vez.')

                return
              }

              try {
                await $.command.run({ command: 'clear', args: '' })
                await $.prompt.submit({ text: 'Retoma desde el checkpoint de Guardian.' })
              } catch {
                $.ui.toast('No se pudo limpiar automáticamente. Ejecuta /clear: Guardian retoma el checkpoint solo.')
              }
            }}
          />
        ) : (
          <Button
            key="handoff"
            label="Traspaso"
            onPress={async () => {
              // Installed by bin/install.js it is /continuity-checkpoint; as a
              // marketplace plugin it carries the plugin's prefix.
              const commands = await $.command.list()
              const found =
                commands.find(c => c.name === 'continuity-checkpoint') ??
                commands.find(c => c.name.endsWith(':continuity-checkpoint'))

              if (found === undefined) {
                $.ui.toast('Falta /continuity-checkpoint: instala Claude Quota Guardian para usar el traspaso.')

                return
              }

              handoffAt = await $.clock.now()
              await update($, waiting, () => true)

              try {
                await $.command.run({ command: found.name, args: '' })
              } catch {
                try {
                  await $.prompt.submit({ text: `/${found.name}` })
                } catch {
                  handoffAt = 0
                  await update($, waiting, () => false)
                  $.ui.toast(`No se pudo iniciar el traspaso. Escribe /${found.name}.`)
                }
              }
            }}
          />
        )}
      </Box>
    )

    return below.type === 'engine' ? (
      mine
    ) : (
      <Box flexDirection="column">
        {mine}
        {below}
      </Box>
    )
  })
}
