import { Logger } from '@nestjs/common'
import * as Sentry from '@sentry/nestjs'

/**
 * T5 Fas C2a — delad enqueue-säkerhet (resiliens/observability).
 *
 * Bakgrund (kartläggningens #58-fynd): när ett Bull-jobb ska köas men SJÄLVA
 * köandet fallerar (Redis nere/frusen) sväljs felet i en `.catch(logger.error)`
 * — ingen Sentry, ingen notis, ingen DB-markör. Avtalet blir ACTIVE, jobben
 * uteblir, och enda spåret är en lograd ingen läser.
 *
 * EMPIRISK MÄTNING (2026-07-31, riktig bull 4.16.5 + ioredis 5.10.1 mot en
 * black-hole-socket) — hela skälet till att den här filen finns:
 *   • Redis uppe:              add tar 0–27 ms.
 *   • Redis NERE (refused):    add rejectar först efter 232,9 s
 *                              (MaxRetriesPerRequestError). Andra add:en i
 *                              samma outage var ännu pending vid 240 s.
 *   • Redis FRUSEN (svarar ej): add rejectar ALDRIG — pending >240 s, noll fel.
 * Bulls egen retryStrategy (`Math.min(Math.exp(times), 20000)`, queue.js:129)
 * är orsaken till minut-skalan. En aktiverings-request som awaitar tre sådana
 * i följd kan alltså hänga i storleksordningen en kvart.
 *
 * Därför gör hjälparen TVÅ saker:
 *   1. LARMAR (Sentry FÖRE swallow) — precis som cron-safety.ts. Aldrig tystare
 *      än idag.
 *   2. GOLVAR väntetiden med en app-nivå timeout, så en hängning blir ett
 *      bounded fel i stället för en oändlig blockering.
 *
 * VALT GOLV — app-nivå Promise.race, inte biblioteksknapparna. Mätt varför:
 *   • `enableOfflineQueue: false` AVVISADES: (a) skyddar inte alls mot frusen
 *     Redis (socketen är skrivbar → pending >45 s ändå), (b) förvandlar
 *     överlevbara blips till förlorat arbete (5–8 s blip: med buffring landade
 *     jobbet efter 11,3 s, utan buffring kastades det efter 1 ms), (c) är
 *     icke-deterministisk (samma blip gav både reject och success beroende på
 *     om klienten hunnit gå till 'reconnecting'), (d) rejectar första enqueue:t
 *     efter varje kallstart även när Redis är fullt uppe (5/5 körningar).
 *   • ioredis `commandTimeout` AVVISADES: Bull delar samma redis-opts till
 *     `bclient` (queue.js:290-297), vars blockerande BRPOPLPUSH är DESIGNAD att
 *     vänta — ett commandTimeout där skulle sabba konsumenten.
 * Buffringen behålls alltså medvetet: den räddar blips och kallstart.
 *
 * ÄRLIG BIVERKNING: en timeout kan inte AVBRYTA köandet. Jobbet kan landa strax
 * efter att vi larmat. Det är ofarligt (statiska jobId dedupar, workers är
 * idempotenta) men innebär att utfallet TIMEOUT betyder "kunde inte bekräftas",
 * INTE "blev inte av". Anropare som notifierar en människa måste formulera sig
 * därefter — se `EnqueueOutcome.status`.
 */

/** Hur lång tid vi som mest väntar på att ett jobb ska bli KÖAT (inte utfört). */
export const ENQUEUE_TIMEOUT_MS = 5_000

/**
 * Utfallet av ett skyddat enqueue-försök.
 *
 * - `ok`      — jobbet är bevisligen köat (jobId finns).
 * - `failed`  — köandet avvisades av Redis/Bull. Jobbet blev INTE av.
 * - `timeout` — köandet svarade inte inom golvet. Vi VET INTE om det blev av;
 *               det kan landa efteråt. Behandla som "kunde inte bekräftas".
 */
export type EnqueueOutcome =
  | { status: 'ok'; jobId: string }
  | { status: 'failed'; error: unknown }
  | { status: 'timeout'; error: unknown }

/** Sant om utfallet inte är ett bekräftat köat jobb (failed ELLER timeout). */
export function isEnqueueProblem(
  outcome: EnqueueOutcome,
): outcome is Extract<EnqueueOutcome, { status: 'failed' | 'timeout' }> {
  return outcome.status !== 'ok'
}

export interface EnqueueSafelyOptions {
  /** Köns namn (Bull-könamnet) — Sentry-tagg + loggprefix. */
  queue: string
  /** Jobbtyp inom kön, t.ex. 'create-initial-notices' — Sentry-tagg. */
  jobType: string
  /** Org-id för korrelation. UUID är en säker korrelationsnyckel (ej PII). */
  organizationId?: string | undefined
  /** Anroparens egen logger (bevarar klasskontext); default: intern logger. */
  logger?: Logger
  /** Väntegolv i ms (default ENQUEUE_TIMEOUT_MS). */
  timeoutMs?: number
}

const defaultLogger = new Logger('EnqueueSafety')

class EnqueueTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Enqueue bekräftades inte inom ${timeoutMs} ms (Redis onåbar eller frusen?)`)
    this.name = 'EnqueueTimeoutError'
  }
}

/**
 * Kör ett enqueue-anrop med väntegolv + larm. Kastar ALDRIG — anroparen får
 * alltid ett utfall tillbaka och bestämmer själv vad som ska hända (t.ex. en
 * SYSTEM-notis till org-admins).
 *
 * Vid problem: full detalj (kan innehålla infra-adresser) ENBART i den lokala
 * loggen; ett SKRUBBAT syntetiskt fel till Sentry med taggar {queue, jobType,
 * org} — samma delning som cron-safety.ts gör.
 */
export async function enqueueSafely(
  enqueue: () => Promise<string>,
  options: EnqueueSafelyOptions,
): Promise<EnqueueOutcome> {
  const logger = options.logger ?? defaultLogger
  const timeoutMs = options.timeoutMs ?? ENQUEUE_TIMEOUT_MS
  const { queue, jobType, organizationId } = options

  let timer: NodeJS.Timeout | undefined
  let outcome: EnqueueOutcome

  // Notera: vi avbryter INTE det underliggande anropet vid timeout — det går
  // inte. Ett sent jobb landar och dedupas av sitt jobId.
  const inflight = enqueue()

  // KRITISKT: Promise.race lämnar förlorarens utfall obevakat. Vinner vår
  // timeout racet och enqueue:t rejectar FÖRST DÄREFTER (mätt: upp till 233 s
  // senare med MaxRetriesPerRequestError) blir det en unhandled rejection — och
  // main.ts:34 svarar på sådana med process.exit(1). En Redis-outage skulle
  // alltså ta ned API:et. Vi hänger på en observatör direkt, vilket markerar
  // rejectionen som hanterad och samtidigt loggar det sena utfallet (nyttigt:
  // det är så man ser att ett larm var ett falsklarm).
  // Flaggan sätts ENBART av timeout-callbacken. Att i stället markera "klar i
  // tid" i race:ets fortsättning vore fel: observatören nedan registreras först
  // och kör därför före den fortsättningen i mikrotask-ordningen — varje normalt
  // enqueue skulle loggas som ett sent falsklarm.
  let timedOut = false
  void inflight.then(
    (jobId) => {
      if (timedOut) {
        logger.warn(
          `[enqueue:${queue}/${jobType}] landade SENT (efter tidsgränsen) — jobId=${jobId}. Tidigare larm var ett falsklarm.`,
        )
      }
    },
    (err: unknown) => {
      if (timedOut) {
        logger.warn(
          `[enqueue:${queue}/${jobType}] misslyckades SENT (efter tidsgränsen): ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    },
  )

  try {
    const jobId = await Promise.race([
      inflight,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          reject(new EnqueueTimeoutError(timeoutMs))
        }, timeoutMs)
      }),
    ])
    outcome = { status: 'ok', jobId }
  } catch (error) {
    outcome =
      error instanceof EnqueueTimeoutError
        ? { status: 'timeout', error }
        : { status: 'failed', error }
  } finally {
    if (timer) clearTimeout(timer)
  }

  if (outcome.status === 'ok') return outcome

  const orgSuffix = organizationId ? ` (org ${organizationId})` : ''
  const verb = outcome.status === 'timeout' ? 'BEKRÄFTADES INTE' : 'MISSLYCKADES'
  logger.error(
    `[enqueue:${queue}/${jobType}] ${verb}${orgSuffix}: ${
      outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
    }`,
    outcome.error instanceof Error ? outcome.error.stack : undefined,
  )
  Sentry.captureException(
    new Error(
      `Enqueue ${queue}/${jobType} ${
        outcome.status === 'timeout' ? 'bekräftades inte inom tidsgränsen' : 'misslyckades'
      } (se serverlogg för detalj)`,
    ),
    { tags: { queue, jobType, org: organizationId } },
  )

  return outcome
}
