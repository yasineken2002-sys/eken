import { MaintenanceCategory, MaintenancePriority } from '@prisma/client'

import { FRAGA } from './shadow-tool-gate'
import {
  BESIKTNINGSVERKTYG,
  KALLGRANS_GRADER,
  PRIORITETSORDNING,
  SUBSTANSGRANS_ORD,
  angivenTemperaturUnder,
  antalOrd,
  hyresgastenSagerIngenBradska,
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
  // ── FIXTUREN FÅR INTE BÄRA ETT KATEGORIORD ────────────────────────────────
  //
  // Den här hette "Trasig lampa" och blev röd när golvet började läsa textens
  // kategoriord: 'lampa' är ett ELECTRICAL-ord, alltså lyfte den till NORMAL.
  // Ett prov som ska visa att INGEN regel träffar måste vara fritt från allt
  // som kan träffa — annars mäter det den regel man glömde.
  const enkel = {
    titel: 'Fråga om sopsortering',
    beskrivning: 'Var ska jag slänga wellpapp, hittar inget kärl på gården',
  }

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
        // FLER ÄN ETT HUSHÅLL — samma familj som 'hela huset'.
        ['grannen säger samma', MaintenancePriority.URGENT],
        ['grannen har också', MaintenancePriority.URGENT],
        ['flera lägenheter', MaintenancePriority.URGENT],
        // VATTEN SOM LIGGER, inte vatten som kommer. Flyttat hit från URGENT.
        ['vatten på golvet', MaintenancePriority.HIGH],
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
        // FÖRKORTADE FRASER: de långa ('står olåst', 'står på glänt') kunde inte
        // matcha "står DEN på glänt" — ett mellanliggande ord räckte. Se
        // negativkontrollen nedan, som är den som faktiskt fäller formen.
        ['olåst', MaintenancePriority.HIGH],
        ['på glänt', MaintenancePriority.HIGH],
        // SANERING AV KROPPSVÄTSKOR.
        ['luktar urin', MaintenancePriority.HIGH],
        ['kissat', MaintenancePriority.HIGH],
        ['avföring', MaintenancePriority.HIGH],
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
      // FIXTUREN SA "Kranen läcker" och blev röd när golvet började läsa textens
      // kategoriord: 'kran' lyfter till NORMAL, och provet mätte då den regeln
      // i stället för 'läcker'. Ordet måste stå ENSAMT för att provet ska säga
      // något om ordet.
      expect(prioritetsgolv(MaintenanceCategory.CLEANING, 'Det läcker', 'Lite bara')).toBe(
        MaintenancePriority.LOW,
      )
    })

    // ── FORMFELET SOM 'står på glänt' BAR ─────────────────────────────────
    //
    // Matchningen är en delsträngsmatchning, så en fras som binder ihop ett verb
    // med sin fortsättning faller på ett enda mellanliggande ord. Uppmätt på
    // korpusen: `k43` skriver "Ibland står den på glänt", och 'står på glänt'
    // matchade inte — ärendet stannade på LOW mot facits HIGH.
    //
    // Provet är riktat mot exakt den formen: den korta frasen ska hittas i BÅDA
    // meningarna, och det gör den bara så länge ordet är den DISTINGERANDE
    // delen och inte en hel sats.
    it('kanariefågel: en fras med ett mellanliggande ord hittas ändå', () => {
      const båda = [
        'Fönstret står på glänt hela tiden',
        'Ibland står den på glänt utan att jag märker det',
      ]
      const missade = båda.filter(
        (t) => prioritetsgolv(MaintenanceCategory.CLEANING, '', t) !== MaintenancePriority.HIGH,
      )
      expect(missade).toEqual([])
    })

    // ── TALET ÄR OCKSÅ ETT NYCKELORD ──────────────────────────────────────
    //
    // Gränsen läses UR KODEN (`KALLGRANS_GRADER`), inte skriven här — annars är
    // det två uppräkningar av samma tal. Båda hållen prövas: ett tal under
    // gränsen ska lyfta, ett på eller över den ska inte.
    it('en angiven temperatur under gränsen lyfter, en över gör det inte', () => {
      const under = `Det är ${KALLGRANS_GRADER - 1} grader inne på morgonen`
      const över = `Det är ${KALLGRANS_GRADER + 2} grader inne på morgonen`
      expect(prioritetsgolv(MaintenanceCategory.CLEANING, '', under)).toBe(MaintenancePriority.HIGH)
      expect(prioritetsgolv(MaintenanceCategory.CLEANING, '', över)).toBe(MaintenancePriority.LOW)
      expect(angivenTemperaturUnder(under, KALLGRANS_GRADER)).toBe(true)
      expect(angivenTemperaturUnder(över, KALLGRANS_GRADER)).toBe(false)
    })

    it('läser inte ett minustecken som en innetemperatur', () => {
      // "-5 grader" är med säkerhet utomhus. Regeln ska tiga, inte gissa.
      expect(angivenTemperaturUnder('det var -5 grader ute i natt', KALLGRANS_GRADER)).toBe(true)
    })

    // ── TEXTENS KATEGORIORD LYFTER OCKSÅ ──────────────────────────────────
    //
    // Den registrerade kategorin kan vara fel — det är korpusens hela premiss.
    // `k15` är ett trasigt lysrör registrerat som COMMON_AREAS.
    it('lyfter till NORMAL när TEXTEN pekar på en riskkategori', () => {
      expect(
        prioritetsgolv(
          MaintenanceCategory.COMMON_AREAS,
          'lampan i tvättstugan trasig',
          'Det är kolmörkt i tvättstugan, lysröret har gått.',
        ),
      ).toBe(MaintenancePriority.NORMAL)
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
    // Regelns hela löfte i ett prov: för VARJE par (registrerat värde, golv) ska
    // resultatet ligga minst lika högt som det registrerade värdet. Faller den
    // här har asymmetrin gått förlorad, och det är det enda som gör golvet
    // ofarligt.
    //
    // ── UNDANTAGET ÄR TAKET, OCH DET PRÖVAS FÖR SIG ────────────────────────
    //
    // `hyresgastenSagerIngenBradska` får sänka, och därför får ingen av
    // texterna här bära en sådan fras. Att blanda in en gjorde provet till en
    // kontroll som inte kunde falla — se det egna blocket nedan.
    it('för varje kombination av registrerat värde och golv', () => {
      const golvtexter = ['inget alls', 'det rinner vatten', 'fuktfläck i taket']
      const sankta: string[] = []
      for (const registrerad of PRIORITETSORDNING) {
        for (const text of golvtexter) {
          const ut = tillämpaRegler(
            { atgärd: 'update_maintenance_status', kategori: 'PLUMBING' },
            {
              titel: '',
              beskrivning: text,
              registreradKategori: MaintenanceCategory.PLUMBING,
              registreradPrioritet: registrerad,
            },
          )
          const före = PRIORITETSORDNING.indexOf(registrerad)
          const efter = PRIORITETSORDNING.indexOf(ut.prioritet)
          if (efter < före) sankta.push(`${registrerad} + "${text}" → ${ut.prioritet}`)
        }
      }
      expect(sankta).toEqual([])
    })

    // ── NEGATIVKONTROLLEN TILL PROVET OVAN ────────────────────────────────
    //
    // Ett prov som bara visar att ingenting sänktes skiljer inte "asymmetrin
    // håller" från "golvet höjer aldrig något alls". Här matas ett registrerat
    // LOW mot texter som MÅSTE lyfta, och kravet är att var och en gör det.
    it('kanariefågel: golvet höjer faktiskt ett lågt registrerat värde', () => {
      const fall: Array<[string, MaintenancePriority]> = [
        ['det rinner vatten i badrummet', MaintenancePriority.URGENT],
        ['det finns en fuktfläck i taket', MaintenancePriority.HIGH],
        ['det är 15 grader inne på morgonen', MaintenancePriority.HIGH],
      ]
      const stumma = fall.filter(
        ([text, väntat]) =>
          tillämpaRegler(
            { atgärd: 'update_maintenance_status', kategori: null },
            {
              titel: '',
              beskrivning: text,
              registreradKategori: MaintenanceCategory.CLEANING,
              registreradPrioritet: MaintenancePriority.LOW,
            },
          ).prioritet !== väntat,
      )
      expect(stumma).toEqual([])
    })

    it('faller tillbaka på golvet när det registrerade värdet inte finns i registret', () => {
      const ut = tillämpaRegler(
        { atgärd: 'update_maintenance_status', kategori: null },
        {
          titel: '',
          beskrivning: 'det rinner vatten',
          registreradKategori: 'PLUMBING',
          registreradPrioritet: 'MEDIUM',
        },
      )
      expect(ut.prioritet).toBe(MaintenancePriority.URGENT)
    })

    it('ger LOW när varken register eller text säger något', () => {
      const ut = tillämpaRegler(
        { atgärd: 'update_maintenance_status', kategori: null },
        {
          titel: '',
          beskrivning: 'inget särskilt här',
          registreradKategori: 'OTHER',
          registreradPrioritet: 'MEDIUM',
        },
      )
      expect(ut.prioritet).toBe(MaintenancePriority.LOW)
    })
  })

  // ── TAKET ─────────────────────────────────────────────────────────────────
  //
  // Egen grupp, därför att det är den ENDA mekanismen i filen som får sänka.
  // Två krav, och det andra är det som gör det ofarligt.
  describe('taket: hyresgästens egen utsaga', () => {
    const löst = {
      titel: 'Ärendet är löst',
      beskrivning: 'Grannen hjälpte mig med elementet igår, det funkar nu. Behöver inte komma.',
    }

    it('sänker ett registrerat NORMAL till LOW när felet sägs vara löst', () => {
      const ut = tillämpaRegler(
        { atgärd: 'update_maintenance_status', kategori: 'HEATING' },
        {
          ...löst,
          registreradKategori: MaintenanceCategory.HEATING,
          registreradPrioritet: MaintenancePriority.NORMAL,
        },
      )
      expect(ut.prioritet).toBe(MaintenancePriority.LOW)
      expect(ut.takSänkte).toBe(true)
    })

    it('sänker också kategorigolvet — ett löst fel är inget fel av någon art', () => {
      expect(
        prioritetsgolv(
          MaintenanceCategory.PLUMBING,
          'Tack, det är fixat',
          'Ni lagade kranen igår, den funkar nu. Kan stänga ärendet.',
        ),
      ).toBe(MaintenancePriority.LOW)
    })

    // DET SOM GÖR TAKET OFARLIGT: `högreAv` ligger sist, så ett nyckelord i
    // texten vinner alltid. Utan den här raden vore taket en väg att sänka ett
    // akut ärende genom att skriva "ingen brådska" i beskrivningen.
    it('når ALDRIG förbi ett nyckelord i texten', () => {
      const ut = tillämpaRegler(
        { atgärd: 'update_maintenance_status', kategori: 'PLUMBING' },
        {
          titel: 'ingen brådska',
          beskrivning: 'det rinner vatten från elementet men ingen brådska',
          registreradKategori: MaintenanceCategory.PLUMBING,
          registreradPrioritet: MaintenancePriority.LOW,
        },
      )
      expect(ut.prioritet).toBe(MaintenancePriority.URGENT)
    })

    // ── KANARIEFÅGEL FÖR TAKETS ORD ────────────────────────────────────────
    //
    // Samma form som golvets: varje fras ska ENSAM kunna utlösa taket, och en
    // text utan någon av dem ska inte göra det. Utan båda hållen kan en fras
    // tystna, eller predikatet alltid svara sant, utan att något blir rött.
    it('kanariefågel: ingen av takets fraser är stum, och inget annat utlöser den', () => {
      const utlöser = [
        'det är fixat nu',
        'ärendet är löst',
        'elementet funkar nu',
        'behöver inte komma',
        'ni kan stänga ärendet',
        'ingen brådska alls',
        'ingen stress',
        'det är inte bråttom',
        'undrar bara',
        'bara en fundering',
      ]
      const stumma = utlöser.filter((t) => !hyresgastenSagerIngenBradska('', t))
      expect(stumma).toEqual([])

      const fårInte = [
        'kranen droppar i badrummet',
        'det är kallt i sovrummet',
        'hissen står stilla sedan i tisdags',
      ]
      expect(fårInte.filter((t) => hyresgastenSagerIngenBradska('', t))).toEqual([])
    })

    it('rör inte ett ärende utan någon sådan utsaga', () => {
      const ut = tillämpaRegler(
        { atgärd: 'update_maintenance_status', kategori: 'HEATING' },
        {
          titel: 'Elementet är kallt',
          beskrivning: 'Det blir inte varmt i sovrummet',
          registreradKategori: MaintenanceCategory.HEATING,
          registreradPrioritet: MaintenancePriority.NORMAL,
        },
      )
      expect(ut.prioritet).toBe(MaintenancePriority.NORMAL)
      expect(ut.takSänkte).toBe(false)
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
      registreradPrioritet: MaintenancePriority.NORMAL,
    }

    it('byggs av modellens första och andra kategorival', () => {
      const ut = tillämpaRegler(
        {
          atgärd: BESIKTNINGSVERKTYG,
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
        const ut = tillämpaRegler({ atgärd: BESIKTNINGSVERKTYG, ...modell }, ärende)
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
          kategori: MaintenanceCategory.HEATING,
          andraKategori: MaintenanceCategory.APPLIANCES,
        },
        // "påminner" och inte något vattenord: vattenorden innehåller "vatten",
        // som ÄR ett kategoriord, och då slutar frågeregeln gälla. De två
        // reglerna läser samma text, och fixturen måste hålla dem isär.
        {
          ...ärende,
          registreradPrioritet: MaintenancePriority.LOW,
          beskrivning: `${ärende.beskrivning}, jag påminner om detta`,
        },
      )
      expect(ut.frågaTvingad).toBe(true)
      expect(ut.prioritet).toBe(MaintenancePriority.HIGH)
    })
  })
})
