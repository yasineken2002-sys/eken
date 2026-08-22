import type { LockService } from './lock.service'

/**
 * En LockService-attrapp som ALLTID släpper igenom.
 *
 * ── VARFÖR EN DELAD ATTRAPP OCH INTE `{} as never` ───────────────────────────
 *
 * Ett tomt objekt räcker för att typkontrollen ska tiga, men då kastar varje
 * test som faktiskt anropar den låsta cron-metoden. Värre: ett test som råkar
 * anropa `*Unsafe`-varianten passerar, och nästa läsare tror att den låsta vägen
 * är täckt.
 *
 * Attrappen kör därför alltid `fn` och rapporterar `ran: true` — alltså exakt
 * det beteende ett ledigt lås har. Ett test som vill pröva ÖVERHOPPET ska
 * använda en egen attrapp som svarar `ran: false`, så att avsikten syns.
 */
export const alltidLedigtLås = {
  runIfUnlocked: async <T>(_key: string, fn: () => Promise<T>) => ({
    ran: true as const,
    value: await fn(),
    heldForSec: null,
  }),
  runWithLock: async <T>(_key: string, fn: () => Promise<T>) => fn(),
} as unknown as LockService
