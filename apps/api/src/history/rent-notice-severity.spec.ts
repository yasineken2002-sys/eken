/**
 * ETT MISSLYCKANDE FÅR INTE RITAS SOM RUTIN.
 *
 * ── VAD SOM MÄTTES ──────────────────────────────────────────────────────────
 *
 * `severityForRentNoticeEvent` matchade på delsträngar och saknade helt
 * misslyckandena. Alla 17 typerna kördes genom funktionen (#648):
 *
 *     SEND_FAILED            INFO
 *     EMAIL_BOUNCED          INFO   ← hårdstoppar hela kravtrappan (INV-B)
 *     NOTICE_EMAIL_BOUNCED   INFO
 *
 * En studsad påminnelse fick alltså grå prick i den enda vy som visade den.
 *
 * ── PROVET RÄKNAR UPP MÄNGDEN, DET STICKPROVAR INTE ─────────────────────────
 *
 * Typerna läses UR SCHEMAT, inte ur en lista här. En ny händelsetyp hamnar
 * därför i provet samma dag den finns, utan att någon kommer ihåg att lägga
 * till den — och en ny typ vars namn säger att den är ett misslyckande fäller
 * provet tills någon klassificerat den.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 * Om en typ vars namn INTE säger "bounced" eller "failed" ändå är ett
 * misslyckande. Den bedömningen kan inte härledas ur ett namn och måste göras
 * av en människa när typen införs.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { severityForRentNoticeEvent } from './history-sources.registry'

const SCHEMA = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8')

/** Enumvärdena ur schemat — kommentarrader bort, inget annat. */
function eventTyper(): string[] {
  const m = /enum RentNoticeEventType \{([\s\S]*?)\n\}/.exec(SCHEMA)
  if (!m) throw new Error('RentNoticeEventType saknas i schema.prisma')
  return m[1]!
    .split('\n')
    .map((r) => r.trim())
    .filter((r) => r.length > 0 && !r.startsWith('//'))
}

describe('severityForRentNoticeEvent', () => {
  it('KANARIEFÅGEL: uppräkningen hittar faktiskt typerna', () => {
    // Utan den här raden kan varje påstående nedan vara sant om en tom mängd.
    const typer = eventTyper()
    expect(typer.length).toBeGreaterThanOrEqual(17)
    expect(typer).toContain('EMAIL_BOUNCED')
    expect(typer).toContain('REMINDER_SENT')
  })

  it('varje MISSLYCKANDE är CRITICAL — härlett ur namnet, inte ur en lista', () => {
    // Fäller en ny `*_BOUNCED`/`*_FAILED`-typ som ingen klassificerat.
    const misslyckanden = eventTyper().filter((t) => t.includes('BOUNCED') || t.includes('FAILED'))
    expect(misslyckanden.length).toBeGreaterThanOrEqual(3)
    for (const t of misslyckanden) {
      expect({ t, sev: severityForRentNoticeEvent(t) }).toEqual({ t, sev: 'CRITICAL' })
    }
  })

  it('DE TRE SOM VAR FEL är rätt nu', () => {
    // Regressionen, namngiven. Fångar inte att mekanismen gått blind — det gör
    // provet ovan — men fastnaglar de exakta fall som en gång var osynliga.
    expect(severityForRentNoticeEvent('EMAIL_BOUNCED')).toBe('CRITICAL')
    expect(severityForRentNoticeEvent('NOTICE_EMAIL_BOUNCED')).toBe('CRITICAL')
    expect(severityForRentNoticeEvent('SEND_FAILED')).toBe('CRITICAL')
  })

  it('MOTPROV: en LYCKAD leverans är inte kritisk', () => {
    // Utan det här provet vore "allt är CRITICAL" en giltig lösning, och då
    // säger färgen inget längre.
    expect(severityForRentNoticeEvent('EMAIL_DELIVERED')).toBe('INFO')
    expect(severityForRentNoticeEvent('NOTICE_EMAIL_DELIVERED')).toBe('INFO')
    expect(severityForRentNoticeEvent('PAYMENT_RECEIVED')).toBe('INFO')
  })

  it('kravtrappans steg behåller sina nivåer', () => {
    expect(severityForRentNoticeEvent('OVERDUE')).toBe('WARNING')
    expect(severityForRentNoticeEvent('REMINDER_SENT')).toBe('WARNING')
    expect(severityForRentNoticeEvent('INTEREST_ACCRUED')).toBe('WARNING')
    expect(severityForRentNoticeEvent('COLLECTION_READY')).toBe('CRITICAL')
    expect(severityForRentNoticeEvent('WRITTEN_OFF')).toBe('CRITICAL')
  })

  it('FÖRDELNINGEN skrivs ut — en mängd som kollapsat ska synas', () => {
    const typer = eventTyper()
    const fördelning = typer.reduce<Record<string, number>>((acc, t) => {
      const s = severityForRentNoticeEvent(t)
      acc[s] = (acc[s] ?? 0) + 1
      return acc
    }, {})
    // Alla tre nivåerna ska vara befolkade. Hamnar allt i en hink har
    // klassificeringen slutat klassificera utan att sluta svara.
    expect(Object.keys(fördelning).sort()).toEqual(['CRITICAL', 'INFO', 'WARNING'])
    expect(fördelning['CRITICAL']).toBeGreaterThanOrEqual(5)
    expect(fördelning['INFO']).toBeGreaterThanOrEqual(5)
  })
})
