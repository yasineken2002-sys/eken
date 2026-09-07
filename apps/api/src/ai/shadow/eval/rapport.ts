/**
 * MÄTRIGGENS RAPPORT — ren funktion, prövbar utan ett enda modellanrop.
 *
 * ── VARFÖR SUMMERINGEN LIGGER SKILD FRÅN KÖRNINGEN ──────────────────────────
 *
 * Riggen kostar pengar och kan inte köras i CI. Låg tabellbygget inne i
 * körskriptet vore det enda som prövade det en manuell körning — alltså aldrig
 * i en grind. Här är det en funktion med indata och utdata, och `rapport.spec.ts`
 * matar den med hittade utfall.
 *
 * Det som INTE går att pröva så — att modellen svarar som den gör — är just det
 * riggen finns för att mäta.
 */

/** Vad facit säger om ett ärende. Samma form som korpusens `facit`. */
export interface Facit {
  kategori: string
  prioritet: string
  atgard: string
  fragaRatt: boolean
  fragaFalt?: string
}

/** Vad agenten svarade för ett ärende. */
export interface Utfall {
  id: string
  /** `FRAGA`, `INGEN` eller ett verktygsnamn. */
  atgard: string
  kategori: string | null
  prioritet: string | null
  confidence: number | null
  /** Frågans fält, när `atgard` är FRAGA. */
  fragaFalt?: string | null
  /** Torrlägets dom om en delegation hade funnits för verktyget. */
  domWouldExecute?: boolean
  /**
   * MODELLENS EGET SVAR, före de deterministiska reglerna i `triage-rules.ts`.
   *
   * De två fälten finns för att en körning annars mäter modell och regel som
   * EN sak. Med dem går det att svara på "vad tillförde golvet" i efterhand,
   * utan att köra om — och att se den dag en regel slutar tillföra något.
   */
  atgardForeRegler?: string
  prioritetForeRegler?: string | null
  /** Ärendets registrerade prioritet — reglernas indata sedan körning 7. */
  registreradPrioritet?: string
  /**
   * KONTROLLSVARET MED MODELL: modellens egen prioritet, höjd av samma golv och
   * sänkt av samma tak — alltså den ordning som gällde till och med körning 6.
   * Räknas ut av riggen genom `tillämpaRegler`, inte här.
   *
   * ── KONTROLLEN HAR BYTT SIDA, OCH DET ÄR HELA POÄNGEN ─────────────────────
   *
   * Fältet hette `prioritetUtanModell` och mätte det billigare alternativet mot
   * det byggda. Sedan körning 7 ÄR det billigare alternativet det byggda:
   * prioriteten sätts av regel, och modellen har ingen röst. Kontrollen mäter
   * därför numera UTMANAREN. Ligger den här raden över `prioritet` ska beslutet
   * omprövas — och tills den gör det är beslutet mätt, inte tyckt.
   */
  prioritetMedModell?: string
  /** Modellens andrahandsval av kategori — frågeregelns andra alternativ. */
  andraKategori?: string
  kostnadUsd: number
  inTokens: number
  utTokens: number
}

export interface Rad {
  antal: number
  traffar: number
  /** `traffar / antal`, eller null när nämnaren är noll. */
  andel: number | null
}

export interface Rapport {
  antal: number
  kategori: Rad
  prioritet: Rad
  atgard: Rad
  fraga: {
    rattFraga: number
    felFraga: number
    missadFraga: number
    /** Andel FEL frågor av alla ärenden — ai-architects tröskel, ≤ 0,10. */
    felFragaAndel: number
  }
  ingen: Rad
  /**
   * VAD DE DETERMINISTISKA REGLERNA TILLFÖRDE, mätt mot modellens eget svar.
   *
   * Utan den här raden är en körning ett tal där modell och regel inte går att
   * skilja åt, och den dag en regel slutar tillföra något syns det inte. Fälten
   * är null när posterna inte bär modellens svar — en äldre körning, eller en
   * rigg som inte skrev fälten. Null betyder "inte mätt", aldrig "noll".
   */
  regler: {
    /** Ärenden där golvet höjde modellens prioritet. */
    golvHojde: number | null
    /** Av dem: hur många blev RÄTT som annars varit fel. */
    golvRaddade: number | null
    /** Av dem: hur många blev FEL som annars varit rätt. */
    golvForstorde: number | null
    /** Besiktningsförslag som gjordes om till frågor. */
    fragaTvingad: number | null
    fragaTvingadRatt: number | null
    /**
     * KONTROLLEN MED MODELL: hur ofta MODELLENS prioritet, genom samma golv och
     * tak, hade träffat facit. Null när posterna inte bär modellens värde.
     *
     * Raden finns för att en träffgrad utan jämförelsepunkt inte säger om
     * regeln är rätt val. Uppmätt i körning 7: regel 50 av 54, modell + regel
     * 46 av 54. Ligger `medModell` ÖVER `prioritet` är det ett besked om att
     * beslutet att koppla bort modellen ska omprövas — inte ett fel.
     */
    prioritetMedModell: Rad | null
  }
  konfidens: Array<{ hink: string; antal: number; ratt: number; andel: number | null }>
  domWouldExecute: number
  kostnad: { totalUsd: number; perArendeUsd: number; inTokens: number; utTokens: number }
}

/** Hinkarna för konfidensfördelningen. Fasta gränser — se `rapport.spec.ts`. */
const HINKAR: ReadonlyArray<{ hink: string; min: number; max: number }> = [
  { hink: '0.00–0.49', min: 0, max: 0.5 },
  { hink: '0.50–0.69', min: 0.5, max: 0.7 },
  { hink: '0.70–0.84', min: 0.7, max: 0.85 },
  { hink: '0.85–1.00', min: 0.85, max: 1.0001 },
]

const rad = (antal: number, traffar: number): Rad => ({
  antal,
  traffar,
  andel: antal === 0 ? null : traffar / antal,
})

/**
 * Var åtgärden rätt?
 *
 * ── EN FRÅGA ÄR RÄTT ÅTGÄRD NÄR FACIT SÄGER DET, ANNARS INTE ────────────────
 *
 * Korpusens frågefall har `atgard: 'INGEN'` OCH `fragaRatt: true` — det finns
 * inget verktyg att föreslå, och rätt svar är att fråga. Den som bara jämförde
 * `atgard` hade räknat en korrekt fråga som en miss, och en missad fråga som en
 * träff. De två fälten måste läsas tillsammans.
 */
function atgardRatt(f: Facit, u: Utfall): boolean {
  if (f.fragaRatt) return u.atgard === 'FRAGA'
  return u.atgard === f.atgard
}

export function byggRapport(poster: ReadonlyArray<{ facit: Facit; utfall: Utfall }>): Rapport {
  const antal = poster.length

  // ── REGLERNAS BIDRAG ──────────────────────────────────────────────────────
  //
  // Mäts bara på poster som faktiskt bär modellens eget svar. Saknas fälten helt
  // blir raden null i stället för noll: en körning från före reglerna ska inte
  // kunna läsas som att reglerna inte gjorde något.
  const medFöre = poster.filter((p) => p.utfall.atgardForeRegler !== undefined)
  const reglerMätta = medFöre.length > 0
  // ── TVÅ VILLKOR, INTE ETT ────────────────────────────────────────────────
  //
  // Golv-fälten läser `registreradPrioritet`, som bara finns från körning 7;
  // fråge-fälten läser `atgardForeRegler`, som finns från körning 4. En sparad
  // körning 4–6 uppfyller det ena men inte det andra, och med ETT villkor blev
  // de tre golv-fälten då `0` — precis det docblocket ovan förbjuder ("null
  // betyder inte mätt, aldrig noll"). Uppmätt på en post utan fältet: `0,0,0`.
  const golvMätta = poster.some((p) => p.utfall.registreradPrioritet !== undefined)
  let golvHojde = 0
  let golvRaddade = 0
  let golvForstorde = 0
  let fragaTvingad = 0
  let fragaTvingadRatt = 0
  const medKontroll = poster.filter((p) => p.utfall.prioritetMedModell !== undefined)
  for (const { facit: f, utfall: u } of medFöre) {
    // JÄMFÖRELSEPUNKTEN ÄR DET REGISTRERADE VÄRDET, inte modellens. Sedan
    // körning 7 är det registrerade värdet reglernas indata; att fortsätta mäta
    // mot modellen hade räknat en skillnad reglerna inte längre orsakar.
    if (u.registreradPrioritet !== undefined && u.registreradPrioritet !== u.prioritet) {
      golvHojde++
      if (u.prioritet === f.prioritet) golvRaddade++
      if (u.registreradPrioritet === f.prioritet) golvForstorde++
    }
    if (u.atgardForeRegler !== u.atgard && u.atgard === 'FRAGA') {
      fragaTvingad++
      if (f.fragaRatt) fragaTvingadRatt++
    }
  }

  // ── KATEGORI OCH PRIORITET RÄKNAS BARA DÄR AGENTEN SVARADE ────────────────
  //
  // En FRÅGA bär numera sin `prediction` (etapp 8 PR 5b), men ett `INGEN` gör
  // det inte. Att räkna ett uteblivet svar som en miss hade gjort träffgraden
  // till ett mått på hur ofta agenten svarar, inte på hur rätt den har — och då
  // hade en agent som gissar alltid slagit en som avstår.
  const medKategori = poster.filter((p) => p.utfall.kategori !== null)
  const medPrioritet = poster.filter((p) => p.utfall.prioritet !== null)

  const frågefall = poster.filter((p) => p.facit.fragaRatt)
  const ickefrågefall = poster.filter((p) => !p.facit.fragaRatt)
  const rattFraga = frågefall.filter((p) => p.utfall.atgard === 'FRAGA').length
  const felFraga = ickefrågefall.filter((p) => p.utfall.atgard === 'FRAGA').length
  const missadFraga = frågefall.length - rattFraga

  const ingenFall = poster.filter((p) => p.facit.atgard === 'INGEN' && !p.facit.fragaRatt)

  const konfidens = HINKAR.map((h) => {
    const i = poster.filter(
      (p) =>
        typeof p.utfall.confidence === 'number' &&
        p.utfall.confidence >= h.min &&
        p.utfall.confidence < h.max,
    )
    const r = i.filter((p) => atgardRatt(p.facit, p.utfall)).length
    return { hink: h.hink, antal: i.length, ratt: r, andel: i.length === 0 ? null : r / i.length }
  })

  const totalUsd = poster.reduce((s, p) => s + p.utfall.kostnadUsd, 0)

  return {
    antal,
    kategori: rad(
      medKategori.length,
      medKategori.filter((p) => p.utfall.kategori === p.facit.kategori).length,
    ),
    prioritet: rad(
      medPrioritet.length,
      medPrioritet.filter((p) => p.utfall.prioritet === p.facit.prioritet).length,
    ),
    atgard: rad(antal, poster.filter((p) => atgardRatt(p.facit, p.utfall)).length),
    regler: {
      golvHojde: golvMätta ? golvHojde : null,
      golvRaddade: golvMätta ? golvRaddade : null,
      golvForstorde: golvMätta ? golvForstorde : null,
      fragaTvingad: reglerMätta ? fragaTvingad : null,
      fragaTvingadRatt: reglerMätta ? fragaTvingadRatt : null,
      prioritetMedModell:
        medKontroll.length === 0
          ? null
          : rad(
              medKontroll.length,
              medKontroll.filter((p) => p.utfall.prioritetMedModell === p.facit.prioritet).length,
            ),
    },
    fraga: {
      rattFraga,
      felFraga,
      missadFraga,
      // NÄMNAREN ÄR ALLA ÄRENDEN, inte bara icke-frågefallen. Tröskeln lyder
      // "frågeandel ≤ 10 % där frågan INTE är rätt", och det är andelen av
      // körningen som slösas — en nämnare som bara räknar icke-frågefall hade
      // gjort talet större ju fler äkta frågefall korpusen har.
      felFragaAndel: antal === 0 ? 0 : felFraga / antal,
    },
    ingen: rad(ingenFall.length, ingenFall.filter((p) => p.utfall.atgard === 'INGEN').length),
    konfidens,
    domWouldExecute: poster.filter((p) => p.utfall.domWouldExecute === true).length,
    kostnad: {
      totalUsd,
      perArendeUsd: antal === 0 ? 0 : totalUsd / antal,
      inTokens: poster.reduce((s, p) => s + p.utfall.inTokens, 0),
      utTokens: poster.reduce((s, p) => s + p.utfall.utTokens, 0),
    },
  }
}

const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(1)} %`)

/** Rapporten som en tabell. Formatet har ett prov — se `rapport.spec.ts`. */
export function formateraRapport(r: Rapport): string {
  const rader: string[] = []
  rader.push(`ÄRENDEN: ${r.antal}`)
  rader.push('')
  rader.push('TRÄFFGRAD          antal  träffar  andel')
  const t = (namn: string, x: Rad) =>
    `${namn.padEnd(18)}${String(x.antal).padStart(5)}${String(x.traffar).padStart(9)}  ${pct(x.andel)}`
  rader.push(t('kategori', r.kategori))
  rader.push(t('prioritet', r.prioritet))
  rader.push(t('åtgärd', r.atgard))
  rader.push(t('inget förslag', r.ingen))
  rader.push('')
  rader.push('FRÅGOR')
  rader.push(`  rätt fråga        ${r.fraga.rattFraga}`)
  rader.push(`  fel fråga         ${r.fraga.felFraga}   (${pct(r.fraga.felFragaAndel)} av alla)`)
  rader.push(`  missad fråga      ${r.fraga.missadFraga}`)
  rader.push('')
  rader.push('REGLERNAS BIDRAG')
  const n = (v: number | null): string => (v === null ? 'ej mätt' : String(v))
  rader.push(
    `  golv/tak ändrade ${n(r.regler.golvHojde)} registrerade värden — räddade ${n(r.regler.golvRaddade)}, förstörde ${n(r.regler.golvForstorde)}`,
  )
  rader.push(
    `  besiktning → fråga     ${n(r.regler.fragaTvingad)} gånger — rätt ${n(r.regler.fragaTvingadRatt)}`,
  )
  const k = r.regler.prioritetMedModell
  rader.push(
    `  KONTROLL med modell    ${k === null ? 'ej mätt' : `${k.traffar}/${k.antal}  ${pct(k.andel)} (modellens prioritet + golvet — utmanaren)`}`,
  )
  rader.push('')
  rader.push('KONFIDENS          antal  rätt  andel')
  for (const k of r.konfidens) {
    rader.push(
      `  ${k.hink.padEnd(16)}${String(k.antal).padStart(5)}${String(k.ratt).padStart(6)}  ${pct(k.andel)}`,
    )
  }
  rader.push('')
  rader.push(`TORRLÄGE: ${r.domWouldExecute} av ${r.antal} hade WOULD_EXECUTE med delegation`)
  rader.push('')
  rader.push(
    `KOSTNAD: $${r.kostnad.totalUsd.toFixed(4)} totalt · $${r.kostnad.perArendeUsd.toFixed(5)}/ärende · ` +
      `${r.kostnad.inTokens} in / ${r.kostnad.utTokens} ut`,
  )
  return rader.join('\n')
}
