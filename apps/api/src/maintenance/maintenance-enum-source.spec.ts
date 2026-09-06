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
import { MaintenanceCategory, MaintenancePriority } from '@prisma/client'
import { MAINTENANCE_CATEGORIES, MAINTENANCE_PRIORITIES } from '@eken/shared'

import { TENANT_TOOLS } from '../ai/tools/tenant-ai-tools.definition'

const verktygetsEnum = (verktyg: string, falt: string): string[] => {
  const t = TENANT_TOOLS.find((x) => x.name === verktyg)
  if (!t) throw new Error(`Verktyget ${verktyg} finns inte — provet mäter fel sak.`)
  const props = (t.input_schema as { properties?: Record<string, { enum?: string[] }> }).properties
  const e = props?.[falt]?.enum
  if (!e) throw new Error(`${verktyg}.${falt} har ingen enum — provet mäter fel sak.`)
  return [...e].sort()
}

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
