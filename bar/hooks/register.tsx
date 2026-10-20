import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { CacheConfig, Usage } from '../types'

// The bar above the prompt: prompt-cache countdown, context size, 5h / week,
// and a one-click handoff through Guardian's /continuity-checkpoint. After the
// checkpoint, "Limpiar y seguir" runs /clear; Guardian's SessionStart hook then
// loads the checkpoint into the fresh session by itself.
//
// Same rule as lib/cache-clock.js (a hooks module cannot require Node code):
// ttl = config cache.ttlMinutes, else 60 min on a subscription (the session
// reports rate limits) and 5 min on an API key. Change both together.

const SUBSCRIPTION_TTL_MINUTES = 60
const API_TTL_MINUTES = 5
const DEFAULTS: CacheConfig = { enabled: true, ttlMinutes: null, warnMinutes: 5 }

const usage = atom({ plugin: 'quota-guardian-bar', key: 'usage' } as const, null)
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

export const register: Register = on => {
  let warned = false
  let ticking = false

  on('session.start', async ($, e, next) => {
    const t = await $.clock.now()
    await update($, now, () => t)

    const home = (await $.env.get('CQG_HOME')) ?? (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))

    if (home !== undefined) {
      try {
        const text = await $.fs.read(`${home}/.claude/session-continuity/config.json`)
        await update($, config, () => parseConfig(text))
      } catch {
        await update($, config, () => DEFAULTS)
      }
    }

    if (!ticking) {
      ticking = true
      $.clock.every(30_000, () => {
        void (async () => {
          const at = await $.clock.now()
          await update($, now, () => at)
          const last = await read($, lastTurn)
          const cfg = await read($, config)
          const data = await read($, usage)

          if (last === 0 || !cfg.enabled) {
            return
          }

          const left = minutesLeft(last, ttlMinutes(cfg, data?.subscription ?? false), at)

          if (left > 0 && left <= cfg.warnMinutes && !warned) {
            warned = true
            $.ui.toast(`Al caché le quedan ${left} min. Envía un mensaje para mantenerlo o haz el traspaso.`, {
              timeoutMs: 15_000,
            })
          }
        })()
      })
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

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const t = await $.clock.now()
      warned = false
      await update($, lastTurn, () => t)
      await update($, now, () => t)

      if (await read($, waiting)) {
        await update($, waiting, () => false)
        await update($, ready, () => true)
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const data = await read($, usage)
    const cfg = await read($, config)
    const last = await read($, lastTurn)
    const at = await read($, now)
    const checkpointReady = await read($, ready)
    const below = await next(e)

    if (e.props.hasSurvey || data === null || !cfg.enabled) {
      return below
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const ttl = ttlMinutes(cfg, data.subscription)
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

              await update($, waiting, () => true)

              try {
                await $.command.run({ command: found.name, args: '' })
              } catch {
                await $.prompt.submit({ text: `/${found.name}` })
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
