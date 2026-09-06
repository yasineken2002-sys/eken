/**
 * PORTALENS FORM ÄR EN DELMÄNGD AV WEBBENS — härlett, inte listat.
 *
 * ── VAD SOM MÄTS ────────────────────────────────────────────────────────────
 *
 * Två klienter skapar felanmälningar mot OLIKA routes — `POST /maintenance`
 * (hyresvärden) och `POST /portal/maintenance` (hyresgästen) — men de möts i
 * `MaintenanceService.create`, som tar supermängden. Portalen skickar tre fält;
 * de sex övriga härleds server-side ur det aktiva avtalet.
 *
 * Relationen är en FÖLJD av konstruktionen: `CreateTicketSchema` ÄR
 * `CreateTicketBaseSchema.extend(...)`. Provet härleder den ur schemana med
 * `Object.keys` i stället för att lista fälten — en handskriven lista hade
 * varit en andra uppräkning som ska vara lika med den första, alltså inte en
 * uppräkning.
 *
 * ── VAD PROVET INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att tjänsten faktiskt FYLLER I de sex fälten på portalvägen. Det ägs av
 * `tenant-portal.service.ts` och dess egna prov. Här mäts formernas relation.
 */
import {
  CreateTicketBaseSchema,
  CreateTicketSchema,
  SubmitTicketSchema,
  TICKET_OWNER_ONLY_FIELDS,
} from '@eken/shared'

const nycklar = (s: { shape: Record<string, unknown> }) => Object.keys(s.shape).sort()

describe('felanmälans två former', () => {
  const bas = nycklar(CreateTicketBaseSchema)
  const agare = nycklar(CreateTicketSchema)
  const portal = nycklar(SubmitTicketSchema)

  it('portalens nycklar är en DELMÄNGD av webbens', () => {
    const utanfor = portal.filter((k) => !agare.includes(k))
    expect(utanfor).toEqual([])
  })

  it('portalens form ÄR basen — ingen egen uppräkning', () => {
    expect(portal).toEqual(bas)
  })

  it('skillnaden är exakt de sex ägarfälten, härledd ur schemana', () => {
    const skillnad = agare.filter((k) => !bas.includes(k))
    expect(skillnad.sort()).toEqual([...TICKET_OWNER_ONLY_FIELDS].sort())
    expect(skillnad).toHaveLength(6)
  })

  /**
   * KANARIEFÅGEL. Delmängdsprovet ovan är grönt om portalen har NOLL fält — en
   * tom mängd är en delmängd av allt. Utan den här raden kan schemat tömmas
   * utan att något blir rött.
   */
  it('KANARIEFÅGEL: basen är icke-tom, och de tre fälten är hyresgästens', () => {
    expect(bas).toEqual(['category', 'description', 'title'])
    expect(agare.length).toBe(9)
  })

  it('de sex ägarfälten är sådant en hyresgäst inte får bestämma', () => {
    // Fastighet/lägenhet/hyresgäst: annars kunde en anmälan peka på någon
    // annans fastighet. Prioritet: hyresvärdens bedömning, inte anmälarens.
    expect([...TICKET_OWNER_ONLY_FIELDS].sort()).toEqual([
      'estimatedCost',
      'priority',
      'propertyId',
      'scheduledDate',
      'tenantId',
      'unitId',
    ])
  })
})
