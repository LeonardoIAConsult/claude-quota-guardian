export type Usage = {
  tokens: number
  percent: number
  fiveHour: number | null
  week: number | null
  usd: number | null
  subscription: boolean
}

export type CacheConfig = {
  enabled: boolean
  ttlMinutes: number | null
  warnMinutes: number
}

declare module 'claude-code' {
  interface PluginState {
    'quota-guardian-bar': {
      usage: Usage | null
      config: CacheConfig
      lastTurn: number
      now: number
      ready: boolean
      waiting: boolean
    }
  }
}
