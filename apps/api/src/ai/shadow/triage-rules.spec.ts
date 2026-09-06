import { MaintenanceCategory, MaintenancePriority } from '@prisma/client'

import { FRAGA } from './shadow-tool-gate'
import {
  BESIKTNINGSVERKTYG,
  PRIORITETSORDNING,
  SUBSTANSGRANS_ORD,
  antalOrd,
  högreAv,
  kategoriordFinns,
  kräverFråga,
  prioritetsgolv,
  tillämpaRegler,
} from './triage-rules'

/**
 * FIXTURER FÖR DE DETERMINISTISKA REGLERNA — noll modellanrop.
 *
 * Det är hela poängen med att reglerna ÄR deterministiska: de går att pröva utan
 * att betala för ett svar, och de kan fällas av ett prov i stället för av en
 * mätning som kostar pengar och tar tjugo minuter.
 *
 * ── VAD DEN HÄR FILEN INTE KAN SE ───────────────────────────────────────────
 *
 * Att reglerna är RÄTT. Ett prov visar att `prioritetsgolv` gör det den säger;
 * om "vatten på golvet" verkligen bör ge URGENT avgörs av mätkorpusen
 * (`eval/`), och i sista hand av en hyresvärd. Filen mäter mekaniken, korpusen
 * mäter omdömet — och de två ska inte förväxlas.
 *
 * Den kan inte heller se att reglerna är PÅKOPPLADE. `tillämpaRegler` anropas
 * från `maintenance-shadow.service.ts` och från `scripts/eval-shadow-agent.ts`;
 * att båda vägarna går genom den ägs av de filerna.
 */
describe('triage-rules', () => {
  const enkel = { titel: 'Trasig lampa', beskrivning: 'Lampan i hallen fungerar inte längre alls' }

  describe('prioritetsgolv', () => {
    it('ger LOW när ingen regel träffar — det betyder "ingen åsikt", inte "oviktigt"', () => {
      expect(prioritetsgolv(MaintenanceCategory.CLEANING, enkel.titel, enkel.beskrivning)).toBe(
        MaintenancePriority.LOW,
      )
    })

    it('lyfter en riskkategori till NORMAL utan nyckelord', () => {
      expect(prioritetsgolv(MaintenanceCategory.PLUMBING, 'Kranen', 'Den är trög att vrida')).toBe(
        MaintenancePriority.NORMAL,
      )
      expect(prioritetsgolv(MaintenanceCategory.ELECTRICAL, 'Uttag', 'Sitter löst i väggen')).toBe(
        MaintenancePriority.NORMAL,
      )
    })

    it('ger URGENT för vatten som rör sig nu', () => {
      expect(
        prioritetsgolv(MaintenanceCategory.OTHER, 'Hjälp', 'Det rinner vatten från elementet'),
      ).toBe(MaintenancePriority.URGENT)
    })

    it('ger HIGH för fukt som står stilla', () => {
      expect(
        prioritetsgolv(MaintenanceCategory.OTHER, 'Fukt', 'Det finns en fuktfläck i taket'),
      ).toBe(MaintenancePriority.HIGH)
    })

    it('läser stora och små bokstäver lika', () => {
      expect(prioritetsgolv(MaintenanceCategory.OTHER, 'GASLUKT I TRAPPHUSET', '')).toBe(
        MaintenancePriority.URGENT,
      )
    })

    // ── KANARIEFÅGELN: VARJE ORD MÅSTE ENSAMT KUNNA LYFTA GOLVET ───────────
    //
    // Utan den här kan ett ord tystna — döpas om i en refaktorering, få en
    // stavning som inte förekommer, eller skuggas av ett bredare ord tidigare i
    // listan — och listan skulle fortsätta se full ut. Provet matar in ordet
    // ENSAMT, i en kategori vars eget golv är LOW, så det enda som kan lyfta
    // svaret är ordet självt.
    //
    // Orden härleds inte ur en andra lista här: de läses ur samma modul genom
    // att golvet frågas. En handskriven kopia av listan hade varit en andra
    // uppräkning, och två uppräkningar som ska vara lika är inte en uppräkning.
    it('kanariefågel: inget ord i golvet är stumt', () => {
      const provord: Array<[string, MaintenancePriority]> = [
        ['forsar', MaintenancePriority.URGENT],
        ['översvämning', MaintenancePriority.URGENT],
        ['rinner ut', MaintenancePriority.URGENT],
        ['strömlös', MaintenancePriority.URGENT],
        ['ingen ström', MaintenancePriority.URGENT],
        ['luktar gas', MaintenancePriority.URGENT],
        ['brinner', MaintenancePriority.URGENT],
        ['utelåst', MaintenancePriority.URGENT],
        ['inbrott', MaintenancePriority.URGENT],
        ['rinner vatten', MaintenancePriority.URGENT],
        ['droppar från taket', MaintenancePriority.URGENT],
        ['vatten på golvet', MaintenancePriority.URGENT],
        ['står vatten', MaintenancePriority.URGENT],
        ['blött på golvet', MaintenancePriority.HIGH],
        ['vatten under', MaintenancePriority.HIGH],
        ['fuktfläck', MaintenancePriority.HIGH],
        ['mögel', MaintenancePriority.HIGH],
        ['råttor', MaintenancePriority.HIGH],
        ['skadedjur', MaintenancePriority.HIGH],
        ['ohyra', MaintenancePriority.HIGH],
        ['blinkar', MaintenancePriority.HIGH],
        ['glappar', MaintenancePriority.HIGH],
        ['iskallt', MaintenancePriority.HIGH],
        ['ingen värme', MaintenancePriority.HIGH],
        ['inget varmvatten', MaintenancePriority.HIGH],
        ['går inte att stänga', MaintenancePriority.HIGH],
        ['står olåst', MaintenancePriority.HIGH],
        ['står på glänt', MaintenancePriority.HIGH],
        ['anmälde', MaintenancePriority.HIGH],
        ['påminner', MaintenancePriority.HIGH],
        ['har inte hänt', MaintenancePriority.HIGH],
      ]
      const stumma = provord.filter(
        ([ord, vantat]) => prioritetsgolv(MaintenanceCategory.CLEANING, '', ord) !== vantat,
      )
      expect(stumma).toEqual([])
    })

    // NEGATIVKONTROLLEN till kanariefågeln: en text UTAN något av orden får inte
    // lyfta golvet. Utan den skulle ett golv som alltid svarade HIGH göra hela
    // provet ovan grönt.
    it('negativkontroll: en text utan nyckelord lyfter ingenting', () => {
      expect(
        prioritetsgolv(
          MaintenanceCategory.CLEANING,
          'Fråga om sopsortering',
          'Var ska jag slänga wellpapp, hittar inget kärl',
        ),
      ).toBe(MaintenancePriority.LOW)
    })

    it('"läcker" lyfter INTE — ordet är tvetydigt och togs bort med mätning', () => {
      expect(
        prioritetsgolv(MaintenanceCategory.CLEANING, 'Kranen läcker', 'Den droppar lite'),
      ).toBe(MaintenancePriority.LOW)
    })
  })

  describe('högreAv', () => {
    it('väljer den högre, oavsett ordning på argumenten', () => {
      expect(högreAv(MaintenancePriority.LOW, MaintenancePriority.HIGH)).toBe(
        MaintenancePriority.HIGH,
      )
      expect(högreAv(MaintenancePriority.HIGH, MaintenancePriority.LOW)).toBe(
        MaintenancePriority.HIGH,
      )
    })

    it('är stabil för lika värden', () => {
      for (const p of PRIORITETSORDNING) expect(högreAv(p, p)).toBe(p)
    })
  })

  describe('golvet SÄNKER aldrig', () => {
    // Regelns hela löfte i ett prov: för VARJE par (modellsvar, golv) ska
    // resultatet ligga minst lika högt som modellens svar. Faller den här har
    // asymmetrin gått förlorad, och det är det enda som gör golvet ofarligt.
    it('för varje kombination av modellsvar och golv', () => {
      const golvtexter = ['inget alls', 'det rinner vatten', 'fuktfläck i taket']
      const sankta: string[] = []
      for (const modell of PRIORITETSORDNING) {
        for (const text of golvtexter) {
          const ut = tillämpaRegler(
            { atgärd: 'update_maintenance_status', prioritet: modell, kategori: 'PLUMBING' },
            { titel: '', beskrivning: text, registreradKategori: MaintenanceCategory.PLUMBING },
          )
          const före = PRIORITETSORDNING.indexOf(modell)
          const efter = PRIORITETSORDNING.indexOf(ut.prioritet!)
          if (efter < före) sankta.push(`${modell} + "${text}" → ${ut.prioritet}`)
        }
      }
      expect(sankta).toEqual([])
    })

    it('lämnar prioriteten null när modellen inte svarade något giltigt', () => {
      const ut = tillämpaRegler(
        { atgärd: 'update_maintenance_status', prioritet: null, kategori: null },
        { titel: '', beskrivning: 'det rinner vatten', registreradKategori: 'PLUMBING' },
      )
      expect(ut.prioritet).toBeNull()
      expect(ut.golvHöjde).toBe(false)
    })

    it('avvisar ett prioritetsvärde som inte finns i registret', () => {
      const ut = tillämpaRegler(
        { atgärd: 'update_maintenance_status', prioritet: 'MEDIUM', kategori: null },
        { titel: '', beskrivning: 'inget särskilt här', registreradKategori: 'OTHER' },
      )
      expect(ut.prioritet).toBeNull()
    })
  })

  describe('kräverFråga', () => {
    const obestamt = {
      titel: 'något låter konstigt',
      beskrivning: 'Det hörs ett ljud någonstans ibland, svårt att beskriva närmare',
    }

    it('gör om en besiktning till en fråga när kategorin är obestämd', () => {
      expect(
        kräverFråga(
          BESIKTNINGSVERKTYG,
          MaintenanceCategory.OTHER,
          obestamt.titel,
          obestamt.beskrivning,
        ),
      ).toBe(true)
    })

    it('rör inte andra verktyg — regeln handlar om besiktningen', () => {
      for (const verktyg of ['update_maintenance_status', 'compose_and_send_email', 'INGEN']) {
        expect(
          kräverFråga(verktyg, MaintenanceCategory.OTHER, obestamt.titel, obestamt.beskrivning),
        ).toBe(false)
      }
    })

    it('rör inte ett ärende vars kategori redan är satt till något annat än OTHER', () => {
      expect(
        kräverFråga(
          BESIKTNINGSVERKTYG,
          MaintenanceCategory.ROOF,
          obestamt.titel,
          obestamt.beskrivning,
        ),
      ).toBe(false)
    })

    it('rör inte ett ärende där texten pekar ut en kategori', () => {
      expect(
        kräverFråga(
          BESIKTNINGSVERKTYG,
          MaintenanceCategory.OTHER,
          'spricka i fasaden',
          'Det har kommit en spricka på fasaden under fönstret',
        ),
      ).toBe(false)
    })

    // LÄNGDGRÄNSEN är det som skiljer en fråga från skräp. Utan den blir varje
    // obegriplig rad ett uppdrag i hyresvärdens inkorg.
    it('rör inte en text utan substans — skräp ska bli tyst, inte en fråga', () => {
      expect(kräverFråga(BESIKTNINGSVERKTYG, MaintenanceCategory.OTHER, 'asdf', 'test test')).toBe(
        false,
      )
    })

    it('gränsen går vid SUBSTANSGRANS_ORD, och den prövas åt båda hållen', () => {
      const ord = (n: number): string => Array.from({ length: n }, () => 'nånting').join(' ')
      expect(antalOrd(ord(SUBSTANSGRANS_ORD))).toBe(SUBSTANSGRANS_ORD)
      expect(
        kräverFråga(BESIKTNINGSVERKTYG, MaintenanceCategory.OTHER, '', ord(SUBSTANSGRANS_ORD)),
      ).toBe(true)
      expect(
        kräverFråga(BESIKTNINGSVERKTYG, MaintenanceCategory.OTHER, '', ord(SUBSTANSGRANS_ORD - 1)),
      ).toBe(false)
    })
  })

  describe('kategoriordFinns', () => {
    it('hittar ord ur flera kategorier', () => {
      expect(kategoriordFinns('Det är stopp i avloppet')).toBe(true)
      expect(kategoriordFinns('Lysröret i tvättstugan har gått')).toBe(true)
      expect(kategoriordFinns('Elementet blir inte varmt')).toBe(true)
    })

    it('säger nej om en text utan kategoriord', () => {
      expect(kategoriordFinns('Det känns lite konstigt ibland men jag vet inte')).toBe(false)
    })

    // ── DELSTRÄNGSFÄLLAN ────────────────────────────────────────────────
    //
    // Matchningen är en delsträngsmatchning, så ett kort kategoriord kan bo
    // inuti ett vanligt svenskt ord. Fyra gjorde det innan de togs bort, och
    // felet var tyst: frågeregeln slutade gälla utan att något blev rött.
    // Raderna nedan är de fyra, och de ska förbli falska.
    it('negativkontroll: vanliga ord får inte matcha som kategoriord', () => {
      const trap = [
        'Det beror nog på något annat', // 'ror'
        'Gardinen hänger snett i vardagsrummet', // 'gard'
        'Stolen står stadigt nu igen', // 'stad'
        'Kan ni kontakta mig i morgon', // 'tak'
        'Det finns ingen bra plats för det', // 'las'
      ]
      expect(trap.filter((t) => kategoriordFinns(t))).toEqual([])
    })
  })

  describe('den tvingade frågan', () => {
    const ärende = {
      titel: 'vet inte vad det är',
      beskrivning: 'Det känns konstigt ibland men jag kan inte säga vad det beror på',
      registreradKategori: MaintenanceCategory.OTHER,
    }

    it('byggs av modellens första och andra kategorival', () => {
      const ut = tillämpaRegler(
        {
          atgärd: BESIKTNINGSVERKTYG,
          prioritet: MaintenancePriority.NORMAL,
          kategori: MaintenanceCategory.OTHER,
          andraKategori: MaintenanceCategory.HEATING,
        },
        ärende,
      )
      expect(ut.frågaTvingad).toBe(true)
      expect(ut.atgärd).toBe(FRAGA)
      expect(ut.fråga?.fält).toBe('category')
      expect(ut.fråga?.alternativ).toEqual([MaintenanceCategory.OTHER, MaintenanceCategory.HEATING])
      expect(ut.fråga?.användsTill).toContain(MaintenanceCategory.HEATING)
    })

    // ── REGRESSIONEN SOM GJORDE REGELN DÖD ────────────────────────────────
    //
    // Första formen byggde alternativen som "modellens gissning eller OTHER".
    // Uppmätt på körning 3: regeln träffade rätt två ärenden och tvingade fram
    // NOLL frågor — modellen svarade `OTHER` i båda, alltså samma värde som
    // ärendet redan var registrerat som, och det fanns inget andra alternativ.
    // Provet nedan är den formen: ett enda kandidatvärde ska INTE ge en fråga,
    // och det som gör regeln levande är att modellen numera ombeds om ett
    // andrahandsval.
    it('lämnar förslaget orört när det bara finns ETT kandidatvärde', () => {
      for (const modell of [
        { kategori: MaintenanceCategory.OTHER, andraKategori: null },
        { kategori: MaintenanceCategory.OTHER, andraKategori: MaintenanceCategory.OTHER },
        { kategori: null, andraKategori: MaintenanceCategory.HEATING as string | null },
      ]) {
        const ut = tillämpaRegler(
          { atgärd: BESIKTNINGSVERKTYG, prioritet: MaintenancePriority.NORMAL, ...modell },
          ärende,
        )
        if (modell.kategori === null) {
          // Ett enda värde, fast från det andra fältet — samma utfall.
          expect(ut.fråga?.alternativ.length ?? 0).toBeLessThan(2)
        }
        expect(ut.frågaTvingad).toBe(false)
        expect(ut.atgärd).toBe(BESIKTNINGSVERKTYG)
      }
    })

    it('golvet gäller ÄVEN när frågan tvingas fram', () => {
      const ut = tillämpaRegler(
        {
          atgärd: BESIKTNINGSVERKTYG,
          prioritet: MaintenancePriority.LOW,
          kategori: MaintenanceCategory.HEATING,
          andraKategori: MaintenanceCategory.APPLIANCES,
        },
        // "påminner" och inte något vattenord: vattenorden innehåller "vatten",
        // som ÄR ett kategoriord, och då slutar frågeregeln gälla. De två
        // reglerna läser samma text, och fixturen måste hålla dem isär.
        { ...ärende, beskrivning: `${ärende.beskrivning}, jag påminner om detta` },
      )
      expect(ut.frågaTvingad).toBe(true)
      expect(ut.prioritet).toBe(MaintenancePriority.HIGH)
    })
  })
})
