/**
 * ÅTERUPPTAGNINGENS OMDÖME — rena prov, ingen databas.
 *
 * ── PROVEN SOM BÄR HELA FILEN ───────────────────────────────────────────────
 *
 * 1. KANARIEFÅGELN. `bedöm` måste kunna säga JA. Utan den kunde funktionen
 *    ersättas med `() => ABSTAIN` och varje annat prov här förbli grönt — en
 *    spärr som alltid stoppar allt bevisar ingenting om vad den stoppar.
 *
 * 2. SPÄRREN MOT KRÄVER_MÄNNISKA. Provet väljer med flit ett verktyg där ALLT
 *    ANNAT säger grönt, och kontrollerar den premissen mot deklarationen i
 *    samma prov. Tas steg 3 ur `bedöm` faller sonden igenom till RESUME.
 *
 * ── SONDENS STYRKA LÄSES UR KODEN, INTE ANTAGEN ─────────────────────────────
 *
 * `send_overdue_reminders` är IDEMPOTENT, har `plats: DATABAS_INDEX` och
 * `policyBeslutad: true`. Den passerar alltså steg 1, 2 och 4 av egen kraft, och
 * åldern sätts i fönstret så steg 5 och 6 också passeras. Skulle någon ändra
 * deklarationen faller premissprovet först — så en sond som slutat vara skarp
 * blir synlig i stället för att tyst mäta ingenting.
 */
import { EFFECT_DECLARATIONS } from '../tools/effect-idempotency'
import { PENDING_ACTION_TTL_MS } from '../pending-action-ttl'
import {
  ATERUPPTAGNING_GOLV_MS,
  ATERUPPTAGNING_TAK_MS,
  SKAL_TEXT,
  bedöm,
  skallSkrivaKörning,
  ärUtåldrad,
} from './resumption-policy'

import type { PåbörjadKörning } from './resumption-policy'

const NU = new Date('2026-09-02T12:00:00.000Z')

/** En rad med tvåfasvägens form. Åldern anges i ms. */
const rad = (over: Partial<PåbörjadKörning> & { ålder?: number } = {}): PåbörjadKörning => ({
  id: 'exec-1',
  organizationId: 'org-1',
  toolName: 'create_property',
  createdAt: new Date(NU.getTime() - (over.ålder ?? 120_000)),
  completedAt: null,
  success: false,
  durationMs: 0,
  harToolResult: false,
  ...over,
})

describe('gränserna', () => {
  it('taket ÄR den befintliga giltighetstiden för en AI-avsikt — inte ett nytt tal', () => {
    // Två tal som ska vara lika men kan ändras var för sig är två gränser som
    // råkar stämma överens just nu.
    expect(ATERUPPTAGNING_TAK_MS).toBe(PENDING_ACTION_TTL_MS)
  })

  it('golvet ligger över den största konfigurerade budget som kan hålla arbete igång', () => {
    // Bulls stall-kuvert (~60 s) är den största; Prismas betaltransaktion 8 s.
    expect(ATERUPPTAGNING_GOLV_MS).toBeGreaterThanOrEqual(60_000)
    expect(ATERUPPTAGNING_GOLV_MS).toBeLessThan(ATERUPPTAGNING_TAK_MS)
  })

  it('varje skäl har en läsbar text — utfallet ska gå att läsa som en lista', () => {
    for (const [skäl, text] of Object.entries(SKAL_TEXT)) {
      expect(text.length).toBeGreaterThan(10)
      expect(skäl).toMatch(/^[A-Z_]+$/)
    }
  })
})

describe('bedöm', () => {
  it('KANARIEFÅGEL: funktionen kan säga JA', () => {
    // Utan det här provet bevisar inget annat prov i filen någonting.
    const dom = bedöm(rad({ toolName: 'create_property', ålder: 120_000 }), NU)
    expect(dom).toEqual({ beslut: 'RESUME', skäl: 'RESUMABLE', ageMs: 120_000 })
  })

  // ── 1. FORMEN ─────────────────────────────────────────────────────────────

  it('en rad från den GAMLA enfasvägen är okänt tillstånd, inte påbörjad', () => {
    // Formen i produktion: 11 av 11 påbörjade rader ser ut så här.
    const dom = bedöm(rad({ success: true, durationMs: 51, harToolResult: true }), NU)
    expect(dom.skäl).toBe('PRE_TWO_PHASE')
  })

  it.each([
    ['success ifyllt', { success: true }],
    ['durationMs ifyllt', { durationMs: 9 }],
    ['toolResult ifyllt', { harToolResult: true }],
    ['redan stängd', { completedAt: new Date(NU) }],
  ])('formen kräver ALLA fyra fälten: %s → avstå', (_namn, avvikelse) => {
    expect(bedöm(rad(avvikelse), NU).beslut).toBe('ABSTAIN')
  })

  // ── 2. KLASSEN ────────────────────────────────────────────────────────────

  it('ett verktyg UTAN deklaration är okänd klassificering', () => {
    // De fem verktyg som faktiskt förekommer i prod är läsverktyg utan post.
    const dom = bedöm(rad({ toolName: 'get_overdue_invoices' }), NU)
    expect(dom.skäl).toBe('UNKNOWN_CLASSIFICATION')
  })

  it('ett verktyg som inte finns alls är okänd klassificering', () => {
    expect(bedöm(rad({ toolName: 'hittepa_verktyg' }), NU).skäl).toBe('UNKNOWN_CLASSIFICATION')
  })

  // ── 3. SPÄRREN ────────────────────────────────────────────────────────────

  describe('KRÄVER_MÄNNISKA återupptas aldrig', () => {
    const SOND = 'send_overdue_reminders'

    it('PREMISS: sonden passerar varje ANNAT steg av egen kraft', () => {
      // Läs tröskeln ur koden innan du litar på sonden. Faller det här provet
      // är det sonden som blivit trubbig, inte spärren som håller.
      const d = EFFECT_DECLARATIONS[SOND]!
      expect(d.resumptionPolicy).toBe('KRÄVER_MÄNNISKA')
      expect(d.policyBeslutad).toBe(true)
      expect(d.effectIdempotency).toBe('IDEMPOTENT')
      expect(d.traceDurability.plats).not.toBe('INGET')
    })

    it('SPÄRREN: allt annat säger grönt, och domen blir ändå avstå', () => {
      // Tas steg 3 ur `bedöm` faller den här sonden igenom till RESUME.
      const dom = bedöm(rad({ toolName: SOND, ålder: 120_000 }), NU)
      expect(dom.beslut).toBe('ABSTAIN')
      expect(dom.skäl).toBe('REQUIRES_HUMAN')
    })

    it('UPPRÄKNING: samtliga KRÄVER_MÄNNISKA-verktyg avstås, inget undantag', () => {
      // Beskriv inte fyndet — räkna upp mängden. Alla 15 har dessutom ett spår,
      // så steg 4 stoppar ingen av dem: spärren är det enda som gör det.
      const kräver = Object.entries(EFFECT_DECLARATIONS).filter(
        ([, d]) => d.resumptionPolicy !== 'AUTOMATISK',
      )
      expect(kräver.length).toBeGreaterThanOrEqual(15)

      for (const [namn] of kräver) {
        const dom = bedöm(rad({ toolName: namn, ålder: 120_000 }), NU)
        expect({ namn, ...dom }).toEqual({
          namn,
          beslut: 'ABSTAIN',
          skäl: 'REQUIRES_HUMAN',
          ageMs: 120_000,
        })
      }
    })

    it('en OBESLUTAD policy räknas som KRÄVER_MÄNNISKA, inte som automatisk', () => {
      // `policyBeslutad: false` betyder "ingen har tänkt på det här än".
      const auto = Object.entries(EFFECT_DECLARATIONS).find(
        ([, d]) => d.resumptionPolicy === 'AUTOMATISK' && d.traceDurability.plats !== 'INGET',
      )!
      const orörd = bedöm(rad({ toolName: auto[0], ålder: 120_000 }), NU)
      expect(orörd.beslut).toBe('RESUME')

      const original = auto[1].policyBeslutad
      try {
        auto[1].policyBeslutad = false
        const dom = bedöm(rad({ toolName: auto[0], ålder: 120_000 }), NU)
        expect(dom.skäl).toBe('REQUIRES_HUMAN')
      } finally {
        auto[1].policyBeslutad = original
      }
    })
  })

  // ── 4. SPÅRET ─────────────────────────────────────────────────────────────

  it('AUTOMATISK men UTAN varaktigt spår återupptas inte', () => {
    // I dag exakt tre: create_invoice, create_maintenance_ticket, create_inspection.
    const utanSpår = Object.entries(EFFECT_DECLARATIONS).filter(
      ([, d]) => d.resumptionPolicy === 'AUTOMATISK' && d.traceDurability.plats === 'INGET',
    )
    expect(utanSpår.length).toBeGreaterThan(0)
    for (const [namn] of utanSpår) {
      expect(bedöm(rad({ toolName: namn, ålder: 120_000 }), NU).skäl).toBe('NO_TRACE')
    }
  })

  // ── 5 och 6. ÅLDERN ───────────────────────────────────────────────────────

  it('yngre än golvet: kan fortfarande vara i luften', () => {
    expect(bedöm(rad({ ålder: ATERUPPTAGNING_GOLV_MS - 1 }), NU).skäl).toBe('TOO_FRESH')
  })

  it('exakt på golvet är innanför', () => {
    expect(bedöm(rad({ ålder: ATERUPPTAGNING_GOLV_MS }), NU).beslut).toBe('RESUME')
  })

  it('exakt på taket är innanför', () => {
    expect(bedöm(rad({ ålder: ATERUPPTAGNING_TAK_MS }), NU).beslut).toBe('RESUME')
  })

  it('äldre än taket: världen har flyttat sig', () => {
    expect(bedöm(rad({ ålder: ATERUPPTAGNING_TAK_MS + 1 }), NU).skäl).toBe('TOO_OLD')
  })

  it('en rad från i somras återupptas aldrig', () => {
    const isomras = 60 * 24 * 60 * 60 * 1000
    expect(bedöm(rad({ ålder: isomras }), NU).skäl).toBe('TOO_OLD')
  })

  // ── FAIL-CLOSED SOM HELHET ────────────────────────────────────────────────

  it('en oigenkänd klassificering öppnar ingen dörr', () => {
    const auto = Object.entries(EFFECT_DECLARATIONS).find(
      ([, d]) => d.resumptionPolicy === 'AUTOMATISK' && d.traceDurability.plats !== 'INGET',
    )!
    const original = auto[1].traceIntegrity
    try {
      auto[1].traceIntegrity = 'OKÄND'
      expect(bedöm(rad({ toolName: auto[0], ålder: 120_000 }), NU).skäl).toBe(
        'UNKNOWN_CLASSIFICATION',
      )
    } finally {
      auto[1].traceIntegrity = original
    }
  })
})

describe('motorn får inte själv bli ett tyst stopp', () => {
  const TIMME = 60 * 60 * 1000
  const skriv = (antalBedömda: number, sedanSenast: number) =>
    skallSkrivaKörning({
      antalBedömda,
      nu: NU,
      senasteHjärtslag: NU.getTime() - sedanSenast,
      hjärtslagMs: TIMME,
    })

  it('ett pass som SÅG något lämnar alltid ett spår', () => {
    expect(skriv(1, 0)).toBe(true)
  })

  it('ett TOMT pass tystas — annars 1 440 rader per dygn som säger ingenting', () => {
    expect(skriv(0, 60_000)).toBe(false)
  })

  it('men en TOM TIMME lämnar ett kvitto ändå', () => {
    // Det här provet är hela svaret på "var syns det att motorn inte gjorde
    // något?". Faller det blir "avstod från allt" och "kördes aldrig" samma
    // tystnad, och den farligare av de två ser normal ut.
    expect(skriv(0, TIMME)).toBe(true)
    expect(skriv(0, TIMME + 1)).toBe(true)
  })

  it('EFTER EN OMSTART skrivs ett hjärtslag direkt', () => {
    // `senasteHjärtslag` börjar på 0 i minnet. Just efter en deploy är det
    // önskvärt att se att motorn kom igång igen.
    expect(
      skallSkrivaKörning({ antalBedömda: 0, nu: NU, senasteHjärtslag: 0, hjärtslagMs: TIMME }),
    ).toBe(true)
  })
})

describe('att åldras ut är ett EGET utfall', () => {
  const GAMMAL = ATERUPPTAGNING_TAK_MS + 60_000

  it('en ÅTERUPPTAGBAR rad som blev för gammal räknas som utåldrad', () => {
    // Det enda avslaget som beskriver ett fel hos MOTORN och inte hos raden.
    const r = rad({ toolName: 'create_property', ålder: GAMMAL })
    expect(bedöm(r, NU).skäl).toBe('TOO_OLD')
    expect(ärUtåldrad(r, NU)).toBe(true)
  })

  it('en KRÄVER_MÄNNISKA-rad som är lika gammal räknas INTE som utåldrad', () => {
    // Den hade aldrig återupptagits, hur snabbt motorn än tittat. Att räkna den
    // som utåldrad hade fått taket att se för snävt ut av fel skäl.
    const r = rad({ toolName: 'send_overdue_reminders', ålder: GAMMAL })
    expect(bedöm(r, NU).skäl).toBe('REQUIRES_HUMAN')
    expect(ärUtåldrad(r, NU)).toBe(false)
  })

  it('en ENFASRAD som är lika gammal räknas INTE som utåldrad', () => {
    // Produktionens elva rader hade annars sett ut som elva missade fönster.
    const r = rad({ ålder: GAMMAL, success: true, durationMs: 51, harToolResult: true })
    expect(ärUtåldrad(r, NU)).toBe(false)
  })

  it('en rad INNE i fönstret är inte utåldrad', () => {
    expect(ärUtåldrad(rad({ ålder: 120_000 }), NU)).toBe(false)
  })

  it('INVARIANT: TOO_OLD och utåldrad är samma mängd — och det beror på stegordningen', () => {
    // Taket prövas SIST, så varje TOO_OLD har passerat form, klass, policy,
    // spår och golv. Den egenskapen är implicit i ordningen. Provet gör den
    // falsifierbar: kastas stegen om så att taket prövas före policyn blir
    // KRÄVER_MÄNNISKA-verktygen TOO_OLD utan att vara utåldrade, och den här
    // ekvivalensen faller.
    const namn = Object.keys(EFFECT_DECLARATIONS)
    let antalTooOld = 0
    for (const toolName of namn) {
      const r = rad({ toolName, ålder: GAMMAL })
      const ärTooOld = bedöm(r, NU).skäl === 'TOO_OLD'
      if (ärTooOld) antalTooOld++
      expect({ toolName, ärTooOld }).toEqual({ toolName, ärTooOld: ärUtåldrad(r, NU) })
    }
    // SONDENS STYRKA: mängden får inte vara tom, annars mäter provet ingenting.
    expect(antalTooOld).toBeGreaterThanOrEqual(10)
  })
})
