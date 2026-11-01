import type { EngineInterface } from 'claude-code'

// Every user-visible text of the bar, in one table. The language follows the
// system: Spanish for an `es*` locale, English for anything else. The terms
// match the browser extension (extension/_locales).

export type Lang = 'es' | 'en'

export const TEXTS = {
  es: {
    cacheLeft: (min: number) => `Caché ${min} min`,
    cacheExpired: 'Caché vencido',
    context: (tokens: string, percent: number) => `Contexto ${tokens} (${percent}% lleno)`,
    fiveHour: '5 h',
    week: 'Semana',
    apiCost: (usd: string) => `Por API US$ ${usd}`,
    rebill: (expired: boolean, tokens: string) =>
      `${expired ? 'El siguiente mensaje vuelve' : 'Si vence, el siguiente mensaje vuelve'} a cobrar ${tokens} tokens`,
    cacheWarning: (min: number) =>
      `Al caché le quedan ${min} min. Envía un mensaje para mantenerlo o haz el traspaso.`,
    clearButton: 'Limpiar y seguir',
    handoffButton: 'Traspaso',
    resumePrompt: 'Retoma desde el checkpoint de Guardian.',
    noCheckpoint:
      'No encontré un checkpoint pendiente de cargar, así que no limpié la sesión. Pulsa Traspaso otra vez.',
    clearFailed: 'No se pudo limpiar automáticamente. Ejecuta /clear: Guardian retoma el checkpoint solo.',
    missingCommand: 'Falta /continuity-checkpoint: instala Claude Quota Guardian para usar el traspaso.',
    handoffFailed: (command: string) => `No se pudo iniciar el traspaso. Escribe /${command}.`,
  },
  en: {
    cacheLeft: (min: number) => `Cache ${min} min`,
    cacheExpired: 'Cache expired',
    context: (tokens: string, percent: number) => `Context ${tokens} (${percent}% full)`,
    fiveHour: '5h',
    week: 'Weekly',
    apiCost: (usd: string) => `API cost US$ ${usd}`,
    rebill: (expired: boolean, tokens: string) =>
      `${expired ? 'The next message will' : 'If it expires, the next message will'} re-bill ${tokens} tokens`,
    cacheWarning: (min: number) =>
      `Cache has ${min} min left. Send a message to keep it alive, or do the handoff.`,
    clearButton: 'Clear and continue',
    handoffButton: 'Handoff',
    resumePrompt: 'Resume from the Guardian checkpoint.',
    noCheckpoint: "No pending checkpoint to load, so I didn't clear the session. Press Handoff again.",
    clearFailed: "Couldn't clear automatically. Run /clear: Guardian resumes from the checkpoint on its own.",
    missingCommand: '/continuity-checkpoint is missing: install Claude Quota Guardian to use the handoff.',
    handoffFailed: (command: string) => `Couldn't start the handoff. Type /${command}.`,
  },
} as const

export type Texts = (typeof TEXTS)[Lang]

// 'es', 'es_CO.UTF-8', 'es-MX' -> es; any other tag -> en; empty, 'C' and
// 'POSIX' say nothing about the language -> null.
export function langOf(locale: string | undefined): Lang | null {
  const tag = (locale ?? '').trim().toLowerCase()

  if (tag === '' || tag === 'c' || tag === 'posix') {
    return null
  }

  return /^es([_.@-]|$)/.test(tag) ? 'es' : 'en'
}

// The POSIX variables first (LC_ALL wins over LANG), then the runtime's locale.
export async function detectLang($: EngineInterface): Promise<Lang> {
  // (the engine wants literal variable names in $.env.get)
  return (
    langOf(await $.env.get('LC_ALL')) ??
    langOf(await $.env.get('LC_MESSAGES')) ??
    langOf(await $.env.get('LANG')) ??
    langOf(Intl.DateTimeFormat().resolvedOptions().locale) ??
    'en'
  )
}
