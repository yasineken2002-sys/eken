/**
 * EN KÄLLA FÖR BESIKTNINGENS ENUMS — och beviset att kopiorna följer den.
 *
 * ── VAD SOM STOD I TRE KOPIOR ───────────────────────────────────────────────
 *
 * Prisma (`InspectionType`, `InspectionStatus`, `InspectionItemCondition`),
 * webbens `inspections.api.ts` (tre egna unionstyper) och ägar-AI:ns
 * verktygsdefinition — där `get_inspections` beskrev värdena som PROSA
 * ("MOVE_IN, MOVE_OUT, PERIODIC, DAMAGE") och `create_inspection` hade en
 * handskriven `enum`. Värdet castades sedan `as never` in i tjänsten.
 *
 * Kopiorna råkade stämma. Det är inte samma sak som att vara bundna: felanmälans
 * motsvarande lista hade glidit till sju värden varav TRE inte finns i
 * databasen, och ingen check föll — därför att ingen check fanns.
 *
 * ── VARFÖR PROV OCH INTE EN DELAD KONSTANT ──────────────────────────────────
 *
 * `@eken/shared` kan inte importera `@prisma/client`; paketet konsumeras av tre
 * webbläsar-SPA:er. Listan i shared är alltså en kopia, och en kopia utan
 * bindning är exakt felet den ersätter. Det här provet ÄR bindningen.
 *
 * Kravet är LIKHET ÅT BÅDA HÅLLEN. "Alla verktygets värden finns i Prisma" hade
 * varit grönt om verktyget bara kände två av fyra — en delmängdskontroll ser
 * inte det som SAKNAS, och en modell som aldrig får veta att `DAMAGE` finns
 * kan inte schemalägga en skadebesiktning.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att värdena BETYDER samma sak. `SIGNED` i Prisma och `SIGNED` i verktyget är
 * lika som strängar; att status-maskinen tillåter övergången dit ägs av
 * `inspections.service.ts`, inte av den här filen.
 */
import { InspectionType, InspectionStatus, InspectionItemCondition } from '@prisma/client'
import { INSPECTION_TYPES, INSPECTION_STATUSES, INSPECTION_ITEM_CONDITIONS } from '@eken/shared'

import { TOOLS } from '../ai/tools/ai-tools.definition'

const verktygetsEnum = (verktyg: string, falt: string): string[] => {
  const t = TOOLS.find((x) => x.name === verktyg)
  if (!t) throw new Error(`Verktyget ${verktyg} finns inte — provet mäter fel sak.`)
  const props = (t.input_schema as { properties?: Record<string, { enum?: string[] }> }).properties
  const e = props?.[falt]?.enum
  if (!e) throw new Error(`${verktyg}.${falt} har ingen enum — provet mäter fel sak.`)
  return [...e].sort()
}

describe('besiktningens enums har EN källa', () => {
  const prismaTyper = Object.values(InspectionType).sort()
  const prismaStatusar = Object.values(InspectionStatus).sort()
  const prismaSkick = Object.values(InspectionItemCondition).sort()

  it('@eken/shared speglar Prismas InspectionType exakt', () => {
    expect([...INSPECTION_TYPES].sort()).toEqual(prismaTyper)
  })

  it('@eken/shared speglar Prismas InspectionStatus exakt', () => {
    expect([...INSPECTION_STATUSES].sort()).toEqual(prismaStatusar)
  })

  it('@eken/shared speglar Prismas InspectionItemCondition exakt', () => {
    expect([...INSPECTION_ITEM_CONDITIONS].sort()).toEqual(prismaSkick)
  })

  it('DEN AVGÖRANDE: create_inspection:s typer är EXAKT Prismas', () => {
    expect(verktygetsEnum('create_inspection', 'type')).toEqual(prismaTyper)
  })

  it('get_inspections filtrerar på EXAKT Prismas typer och statusar', () => {
    expect(verktygetsEnum('get_inspections', 'type')).toEqual(prismaTyper)
    expect(verktygetsEnum('get_inspections', 'status')).toEqual(prismaStatusar)
  })

  /**
   * KANARIEFÅGEL. Utan den kan proven ovan vara gröna av att `verktygetsEnum`
   * slutat hitta något: den kastar bara när verktyget eller fältet saknas, och
   * en TOM lista hade jämförts mot en tom lista om Prisma också gav noll.
   *
   * `RENOVATION` och `ARCHIVED` är de värden en språkmodell rimligen GISSAR på
   * en svensk fråga om besiktningar — och de finns inte. De är negativkontroller
   * mot en lista som råkat växa åt fel håll, inte mot ett stavfel.
   */
  it('KANARIEFÅGEL: mängderna är icke-tomma, och de gissade värdena finns inte', () => {
    expect(prismaTyper.length).toBe(4)
    expect(prismaStatusar.length).toBe(4)
    expect(prismaSkick.length).toBe(4)
    for (const gissad of ['RENOVATION', 'ARCHIVED', 'BROKEN']) {
      expect(prismaTyper).not.toContain(gissad)
      expect(prismaStatusar).not.toContain(gissad)
      expect(prismaSkick).not.toContain(gissad)
      expect(verktygetsEnum('create_inspection', 'type')).not.toContain(gissad)
    }
    // …och de värden som FINNS ska vara med, så listan inte kan tömmas tyst.
    expect(verktygetsEnum('create_inspection', 'type')).toContain('DAMAGE')
    expect(verktygetsEnum('get_inspections', 'status')).toContain('SIGNED')
  })
})
