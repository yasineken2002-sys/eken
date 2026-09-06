import { byggRapport, formateraRapport, type Facit, type Utfall } from './rapport'

/**
 * RAPPORTENS SUMMERING — prövad utan ett enda modellanrop.
 *
 * Riggen kostar pengar och kan inte köras i CI. Låg tabellbygget inne i
 * körskriptet vore det enda som prövade det en manuell körning, alltså aldrig i
 * en grind. Här matas kända utfall in och summan krävs.
 *
 * VAD DEN INTE MÄTER: att modellen svarar som den gör. Det är just vad riggen
 * finns för att mäta, och det går per definition inte att göra utan att betala.
 */
const f = (över: Partial<Facit> = {}): Facit => ({
  kategori: 'PLUMBING',
  prioritet: 'NORMAL',
  atgard: 'update_maintenance_status',
  fragaRatt: false,
  ...över,
})

const u = (över: Partial<Utfall> = {}): Utfall => ({
  id: 'x',
  atgard: 'update_maintenance_status',
  kategori: 'PLUMBING',
  prioritet: 'NORMAL',
  confidence: 0.9,
  kostnadUsd: 0.001,
  inTokens: 100,
  utTokens: 50,
  ...över,
})

describe('byggRapport', () => {
  describe('reglernas bidrag', () => {
    // ── NULL BETYDER "INTE MÄTT", ALDRIG "NOLL" ────────────────────────────
    //
    // En körning från före reglerna bär inte fälten. Räknade rapporten dem som
    // noll hade den sagt att reglerna inte tillförde något — vilket är ett
    // PÅSTÅENDE om en mätning som aldrig gjordes, och exakt den sortens tystnad
    // som gör ett tal värdelöst.
    it('är null när posterna inte bär modellens eget svar', () => {
      const r = byggRapport([{ facit: f(), utfall: u() }])
      expect(r.regler.golvHojde).toBeNull()
      expect(r.regler.fragaTvingad).toBeNull()
      expect(formateraRapport(r)).toContain('ej mätt')
    })

    it('räknar en höjning som RÄDDADE ett svar', () => {
      const r = byggRapport([
        {
          facit: f({ prioritet: 'HIGH' }),
          utfall: u({
            prioritet: 'HIGH',
            atgardForeRegler: 'update_maintenance_status',
            prioritetForeRegler: 'NORMAL',
          }),
        },
      ])
      expect(r.regler.golvHojde).toBe(1)
      expect(r.regler.golvRaddade).toBe(1)
      expect(r.regler.golvForstorde).toBe(0)
    })

    it('räknar en höjning som FÖRSTÖRDE ett svar — regeln får inte se bra ut gratis', () => {
      const r = byggRapport([
        {
          facit: f({ prioritet: 'NORMAL' }),
          utfall: u({
            prioritet: 'HIGH',
            atgardForeRegler: 'update_maintenance_status',
            prioritetForeRegler: 'NORMAL',
          }),
        },
      ])
      expect(r.regler.golvHojde).toBe(1)
      expect(r.regler.golvRaddade).toBe(0)
      expect(r.regler.golvForstorde).toBe(1)
    })

    it('räknar en tvingad fråga och om den var rätt', () => {
      const r = byggRapport([
        {
          facit: f({ atgard: 'INGEN', fragaRatt: true }),
          utfall: u({
            atgard: 'FRAGA',
            atgardForeRegler: 'create_inspection',
            prioritetForeRegler: 'NORMAL',
          }),
        },
        {
          facit: f(),
          utfall: u({
            atgard: 'FRAGA',
            atgardForeRegler: 'create_inspection',
            prioritetForeRegler: 'NORMAL',
          }),
        },
      ])
      expect(r.regler.fragaTvingad).toBe(2)
      expect(r.regler.fragaTvingadRatt).toBe(1)
    })
  })

  it('en full träff räknas i alla tre fälten', () => {
    const r = byggRapport([{ facit: f(), utfall: u() }])
    expect(r.kategori).toEqual({ antal: 1, traffar: 1, andel: 1 })
    expect(r.prioritet).toEqual({ antal: 1, traffar: 1, andel: 1 })
    expect(r.atgard).toEqual({ antal: 1, traffar: 1, andel: 1 })
  })

  it('EN FRÅGA är rätt åtgärd när facit säger det — inte en miss', () => {
    // Korpusens frågefall har `atgard: 'INGEN'` OCH `fragaRatt: true`. Den som
    // bara jämförde `atgard` hade räknat en korrekt fråga som en miss.
    const r = byggRapport([
      { facit: f({ atgard: 'INGEN', fragaRatt: true }), utfall: u({ atgard: 'FRAGA' }) },
    ])
    expect(r.atgard.traffar).toBe(1)
    expect(r.fraga.rattFraga).toBe(1)
    expect(r.fraga.felFraga).toBe(0)
    expect(r.fraga.missadFraga).toBe(0)
  })

  it('och en MISSAD fråga räknas som en miss, inte som ett rätt INGEN', () => {
    const r = byggRapport([
      { facit: f({ atgard: 'INGEN', fragaRatt: true }), utfall: u({ atgard: 'INGEN' }) },
    ])
    expect(r.atgard.traffar).toBe(0)
    expect(r.fraga.missadFraga).toBe(1)
    // Och den räknas INTE i "inget förslag": det fallet gäller bara där INGEN
    // verkligen är rätt svar, inte där en fråga var det.
    expect(r.ingen.antal).toBe(0)
  })

  it('en fråga där facit INTE ville ha en är en FEL fråga', () => {
    const r = byggRapport([{ facit: f(), utfall: u({ atgard: 'FRAGA' }) }])
    expect(r.fraga.felFraga).toBe(1)
    expect(r.atgard.traffar).toBe(0)
  })

  it('felFrågeandelens NÄMNARE är alla ärenden, inte bara icke-frågefallen', () => {
    // Tröskeln lyder "≤ 10 % där frågan INTE är rätt" och mäter hur stor del av
    // körningen som slösas. En nämnare som bara räknade icke-frågefall hade
    // gjort talet större ju fler ÄKTA frågefall korpusen har — alltså straffat
    // en bättre korpus.
    const poster = [
      { facit: f(), utfall: u({ atgard: 'FRAGA' }) },
      ...Array.from({ length: 9 }, () => ({ facit: f(), utfall: u() })),
    ]
    expect(byggRapport(poster).fraga.felFragaAndel).toBeCloseTo(0.1, 5)
  })

  it('KATEGORI OCH PRIORITET räknas bara där agenten svarade', () => {
    // Ett `INGEN` bär ingen prediction. Att räkna det som en miss hade gjort
    // träffgraden till ett mått på hur ofta agenten svarar — och då hade en
    // agent som alltid gissar slagit en som avstår.
    const r = byggRapport([
      { facit: f(), utfall: u() },
      {
        facit: f({ atgard: 'INGEN' }),
        utfall: u({ atgard: 'INGEN', kategori: null, prioritet: null }),
      },
    ])
    expect(r.kategori).toEqual({ antal: 1, traffar: 1, andel: 1 })
    expect(r.antal).toBe(2)
  })

  it('konfidenshinkarna delar in på de deklarerade gränserna', () => {
    const r = byggRapport([
      { facit: f(), utfall: u({ confidence: 0.49 }) },
      { facit: f(), utfall: u({ confidence: 0.5 }) },
      { facit: f(), utfall: u({ confidence: 0.7 }) },
      { facit: f(), utfall: u({ confidence: 0.85 }) },
      { facit: f(), utfall: u({ confidence: 1 }) },
    ])
    expect(r.konfidens.map((k) => k.antal)).toEqual([1, 1, 1, 2])
  })

  it('en post UTAN konfidens hamnar i ingen hink — null är inte noll', () => {
    const r = byggRapport([{ facit: f(), utfall: u({ confidence: null }) }])
    expect(r.konfidens.reduce((s, k) => s + k.antal, 0)).toBe(0)
    // …men den räknas fortfarande i åtgärdsträffgraden.
    expect(r.atgard.antal).toBe(1)
  })

  it('kostnaden summeras och delas per ärende', () => {
    const r = byggRapport([
      { facit: f(), utfall: u({ kostnadUsd: 0.002, inTokens: 10, utTokens: 5 }) },
      { facit: f(), utfall: u({ kostnadUsd: 0.004, inTokens: 20, utTokens: 7 }) },
    ])
    expect(r.kostnad.totalUsd).toBeCloseTo(0.006, 9)
    expect(r.kostnad.perArendeUsd).toBeCloseTo(0.003, 9)
    expect(r.kostnad.inTokens).toBe(30)
    expect(r.kostnad.utTokens).toBe(12)
  })

  it('torrlägets domar räknas', () => {
    const r = byggRapport([
      { facit: f(), utfall: u({ domWouldExecute: true }) },
      { facit: f(), utfall: u({ domWouldExecute: false }) },
      { facit: f(), utfall: u() },
    ])
    expect(r.domWouldExecute).toBe(1)
  })

  it('EN TOM körning ger noll, inte NaN — och andelarna blir null', () => {
    const r = byggRapport([])
    expect(r.antal).toBe(0)
    expect(r.kategori.andel).toBeNull()
    expect(r.kostnad.perArendeUsd).toBe(0)
    expect(Number.isNaN(r.fraga.felFragaAndel)).toBe(false)
  })
})

describe('formateraRapport', () => {
  it('bär alla fyra avsnitten och ett tal per rad', () => {
    const text = formateraRapport(
      byggRapport([
        { facit: f(), utfall: u() },
        { facit: f({ atgard: 'INGEN', fragaRatt: true }), utfall: u({ atgard: 'FRAGA' }) },
      ]),
    )
    for (const rubrik of ['TRÄFFGRAD', 'FRÅGOR', 'KONFIDENS', 'TORRLÄGE', 'KOSTNAD']) {
      expect(text).toContain(rubrik)
    }
    expect(text).toContain('ÄRENDEN: 2')
  })

  it('en tom hink skrivs som TANKSTRECK, inte som 0 %', () => {
    // `0 %` läses som "aldrig rätt"; tankstreck säger "inget mätt". Samma skäl
    // som träffgradens `—` i inkorgen.
    const text = formateraRapport(byggRapport([{ facit: f(), utfall: u({ confidence: 0.9 }) }]))
    expect(text).toContain('—')
  })
})
