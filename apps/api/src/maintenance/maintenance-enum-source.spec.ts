/**
 * EN KÄLLA FÖR FELANMÄLANS ENUMS — och beviset att kopiorna följer den.
 *
 * ── VAD SOM HÄNDE ───────────────────────────────────────────────────────────
 *
 * `tenant-ai-tools.definition.ts` räknade upp SJU kategorier. Tre av dem finns
 * inte i databasen — `APPLIANCE` (Prisma har `APPLIANCES`), `STRUCTURAL` och
 * `PEST` — och fyra av Prismas elva saknades. Verktygets värde castades sedan
 * `as MaintenanceCategory` utan kontroll.
 *
 * Kedjan: en hyresgäst skriver "det är skadedjur i köket" → modellen väljer
 * `PEST`, som står i verktygets schema → castet påstår att det är en giltig
 * kategori → Postgres avvisar värdet. Ett 500-fel som väntade på rätt ord.
 *
 * ── VARFÖR PROV OCH INTE BARA EN DELAD KONSTANT ─────────────────────────────
 *
 * `@eken/shared` kan inte importera `@prisma/client`: paketet konsumeras av tre
 * webbläsar-SPA:er. Listan i shared är därför en KOPIA av Prismas enum, och en
 * kopia utan bindning är exakt felet den ersätter. Det här provet är bindningen.
 *
 * Kravet är LIKHET ÅT BÅDA HÅLLEN. "Alla verktygets värden finns i Prisma" hade
 * varit grönt om verktyget bara kände tre av elva — en delmängdskontroll ser
 * inte det som SAKNAS, och en modell som aldrig får veta att `ROOF` finns
 * väljer `OTHER` för ett trasigt tak.
 */
import {
  MaintenanceCategory,
  MaintenancePriority,
  MaintenanceStatus,
  RentNoticeStatus,
} from '@prisma/client'
import {
  MAINTENANCE_CATEGORIES,
  MAINTENANCE_PRIORITIES,
  MAINTENANCE_STATUSES,
  RENT_NOTICE_STATUSES,
  AI_SETTABLE_MAINTENANCE_STATUSES,
  AI_EJ_SATTBAR_MAINTENANCE_STATUS,
} from '@eken/shared'

import { TENANT_TOOLS } from '../ai/tools/tenant-ai-tools.definition'
import { TOOLS as AGAR_TOOLS } from '../ai/tools/ai-tools.definition'

const enumUr = (
  katalog: ReadonlyArray<{ name: string; input_schema: unknown }>,
  verktyg: string,
  falt: string,
): string[] => {
  const t = katalog.find((x) => x.name === verktyg)
  if (!t) throw new Error(`Verktyget ${verktyg} finns inte — provet mäter fel sak.`)
  const props = (t.input_schema as { properties?: Record<string, { enum?: string[] }> }).properties
  const e = props?.[falt]?.enum
  if (!e) throw new Error(`${verktyg}.${falt} har ingen enum — provet mäter fel sak.`)
  return [...e].sort()
}

/** Hyresgästens katalog. */
const verktygetsEnum = (verktyg: string, falt: string): string[] =>
  enumUr(TENANT_TOOLS as ReadonlyArray<{ name: string; input_schema: unknown }>, verktyg, falt)

/** Ägarens katalog — den som hade sex `as never` och tre enums bara i PROSA. */
const agarensEnum = (verktyg: string, falt: string): string[] =>
  enumUr(AGAR_TOOLS as ReadonlyArray<{ name: string; input_schema: unknown }>, verktyg, falt)

describe('felanmälans enums har EN källa', () => {
  const prismaKategorier = Object.values(MaintenanceCategory).sort()
  const prismaPrioriteter = Object.values(MaintenancePriority).sort()

  it('@eken/shared speglar Prismas MaintenanceCategory exakt', () => {
    expect([...MAINTENANCE_CATEGORIES].sort()).toEqual(prismaKategorier)
  })

  it('@eken/shared speglar Prismas MaintenancePriority exakt', () => {
    expect([...MAINTENANCE_PRIORITIES].sort()).toEqual(prismaPrioriteter)
  })

  it('DEN AVGÖRANDE: hyresgästverktygets kategorier är EXAKT Prismas', () => {
    expect(verktygetsEnum('create_maintenance_ticket', 'category')).toEqual(prismaKategorier)
  })

  it('hyresgästverktygets prioriteter är EXAKT Prismas', () => {
    expect(verktygetsEnum('create_maintenance_ticket', 'priority')).toEqual(prismaPrioriteter)
  })

  /**
   * KANARIEFÅGEL. Utan den kan proven ovan vara gröna av att `verktygetsEnum`
   * slutat hitta något — den kastar visserligen, men bara om verktyget eller
   * fältet saknas; en TOM lista hade jämförts mot en tom lista om Prisma också
   * gav noll. Det här kräver att båda mängderna faktiskt bär värden, och att de
   * tre påhittade INTE finns.
   */
  it('KANARIEFÅGEL: mängderna är icke-tomma, och de tre påhittade finns inte', () => {
    expect(prismaKategorier.length).toBe(11)
    expect(prismaPrioriteter.length).toBe(4)
    for (const pahittad of ['APPLIANCE', 'STRUCTURAL', 'PEST']) {
      expect(prismaKategorier).not.toContain(pahittad)
      expect(verktygetsEnum('create_maintenance_ticket', 'category')).not.toContain(pahittad)
    }
    // …och det värde som FANNS men saknades i verktyget ska nu vara med.
    expect(verktygetsEnum('create_maintenance_ticket', 'category')).toContain('ROOF')
  })
})

/**
 * ÄGARENS VÄG — samma defekt, ett år senare och en katalog bort.
 *
 * Sex `as never` i `tool-executor.service.ts` castade modellens svar rakt in i
 * Prismas where- och create-satser. TRE av de fyra verktygen deklarerade inte
 * ens sin enum: statusarna stod som PROSA i en `description`, alltså som text
 * modellen läser men ingenting kontrollerar. Två av de prosalistorna var
 * dessutom OFULLSTÄNDIGA:
 *
 *   get_maintenance_tickets.status   prosa 5 · Prisma 6 — CANCELLED saknades
 *   get_rent_notices.status          prosa 5 · Prisma 6 — FAILED saknades
 *   create_maintenance_ticket.category   ingen lista alls, varken enum eller prosa
 *
 * Ett värde en modell aldrig får veta finns är ett värde den aldrig väljer. Det
 * är inte ett fel som syns som ett fel — det syns som att funktionen saknas.
 */
describe('ägarverktygens enums har SAMMA källa', () => {
  const prismaKategorier = Object.values(MaintenanceCategory).sort()
  const prismaPrioriteter = Object.values(MaintenancePriority).sort()
  const prismaStatusar = Object.values(MaintenanceStatus).sort()
  const prismaAviStatusar = Object.values(RentNoticeStatus).sort()

  it('@eken/shared speglar Prismas MaintenanceStatus exakt', () => {
    expect([...MAINTENANCE_STATUSES].sort()).toEqual(prismaStatusar)
  })

  it('@eken/shared speglar Prismas RentNoticeStatus exakt', () => {
    expect([...RENT_NOTICE_STATUSES].sort()).toEqual(prismaAviStatusar)
  })

  it('get_maintenance_tickets filtrerar på EXAKT Prismas status och prioritet', () => {
    expect(agarensEnum('get_maintenance_tickets', 'status')).toEqual(prismaStatusar)
    expect(agarensEnum('get_maintenance_tickets', 'priority')).toEqual(prismaPrioriteter)
  })

  it('create_maintenance_ticket har EXAKT Prismas kategorier och prioriteter', () => {
    expect(agarensEnum('create_maintenance_ticket', 'category')).toEqual(prismaKategorier)
    expect(agarensEnum('create_maintenance_ticket', 'priority')).toEqual(prismaPrioriteter)
  })

  it('get_rent_notices filtrerar på EXAKT Prismas avistatusar', () => {
    expect(agarensEnum('get_rent_notices', 'status')).toEqual(prismaAviStatusar)
  })

  /**
   * DELMÄNGDEN — och den enda posten där likhet vore FEL.
   *
   * `update_maintenance_status` får inte sätta `NEW`: det betyder otriagerat,
   * och att flytta ett ärende dit tillbaka raderar att någon tittat på det.
   * Kravet är därför delmängd plus exakt ett känt undantag — inte likhet, och
   * inte en fri delmängd, som hade varit grön även om verktyget tappat tre till.
   */
  it('update_maintenance_status är Prismas statusar MINUS exakt NEW', () => {
    const verktyget = agarensEnum('update_maintenance_status', 'newStatus')
    expect(verktyget).toEqual([...AI_SETTABLE_MAINTENANCE_STATUSES].sort())
    expect(verktyget).toEqual(prismaStatusar.filter((s) => s !== AI_EJ_SATTBAR_MAINTENANCE_STATUS))
    expect(verktyget).not.toContain('NEW')
    expect(verktyget).toHaveLength(prismaStatusar.length - 1)
  })

  /**
   * KANARIEFÅGEL. `agarensEnum` kastar om verktyget eller fältet saknas, men
   * inte om BÅDA mängderna blivit tomma. Den kräver också att de två värden som
   * saknades i prosan nu faktiskt går att välja — det var hela fyndet.
   */
  it('KANARIEFÅGEL: mängderna är icke-tomma, och de två saknade värdena finns nu', () => {
    expect(prismaStatusar).toHaveLength(6)
    expect(prismaAviStatusar).toHaveLength(6)
    expect(agarensEnum('get_maintenance_tickets', 'status')).toContain('CANCELLED')
    expect(agarensEnum('get_rent_notices', 'status')).toContain('FAILED')
    expect(() => agarensEnum('get_rent_notices', 'manad')).toThrow()
    expect(() => agarensEnum('finns_inte_alls', 'status')).toThrow()
  })
})
