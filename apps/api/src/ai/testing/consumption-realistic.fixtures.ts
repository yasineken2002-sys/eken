/**
 * Fiktiva fastigheter och månadsavläsningar. Facit skrivs före modellprovet.
 * scenario beskriver konstruktörens verklighet; den skickas ALDRIG till modellen.
 * Observationer kan ge en granskningssignal utan att avslöja den verkliga orsaken.
 */
import type { ReviewReading } from '@eken/shared'
import type { PrismaService } from '../../common/prisma/prisma.service'

export const SYNTHETIC_ORG = 'synthetic-org-bjorkgarden'
type Code = 'HIGH_RATE' | 'DATA' | 'OVERLAP' | 'DECREASE'
export interface RealisticConsumptionCase {
  id: string
  scenario: string
  question: string
  rows: ReviewReading[]
  expected: {
    trendAssessed: number
    findings: { readingId: string; code: Code }[]
    trend?: { quantity: number; days: number; perDay: number; median: number; threshold: number }
  }
  supported: string
  unsupported: string
}

const at = (month: number, day: number) => new Date(Date.UTC(2026, month - 1, day)).toISOString()
function months(values: number[], meterId = 'water-a'): ReviewReading[] {
  return values.map((value, i) => ({
    id: `${meterId}-${i + 1}`,
    organizationId: SYNTHETIC_ORG,
    meterId,
    readingType: 'PERIOD_VOLUME',
    value: String(value),
    periodStart: at(i + 1, 1),
    periodEnd: at(i + 2, 0),
  }))
}
function cumulative(values: number[]): ReviewReading[] {
  return months(values).map((row) => ({ ...row, readingType: 'CUMULATIVE' }))
}
function high(quantity: number, days = 30) {
  return { quantity, days, perDay: quantity / days, median: 0.3, threshold: 0.9 }
}
const finding = (code: Code, readingId = 'water-a-4') => ({ readingId, code })

export function realisticConsumptionCases(): RealisticConsumptionCase[] {
  const normal = () => months([9.3, 8.4, 9.3, 9])
  const gap = normal()
  gap[3] = { ...gap[3]!, value: '36', periodStart: at(6, 1), periodEnd: at(6, 30) }
  const overlap = normal()
  overlap[3] = { ...overlap[3]!, periodStart: at(3, 31) }
  const inverted = normal()
  inverted[3] = { ...inverted[3]!, periodStart: at(5, 2), periodEnd: at(5, 1) }
  const replaced = cumulative([500, 508.4, 517.7, 3, 12.3])
  const separateMeter = replaced.map((row, i) => (i < 3 ? row : { ...row, meterId: 'water-new' }))
  const duplicate = [...normal(), { ...normal()[3]!, id: 'water-a-copy', value: '9.1' }]
  return [
    {
      id: 'olika-manadslangd',
      scenario: 'Samma vattenförbrukning per dag i januari–april, trots olika månadslängd.',
      question: 'Läs mina vattenavläsningar. Februari har mindre volym än januari. Är något fel?',
      rows: normal(),
      expected: { trendAssessed: 1, findings: [] },
      supported:
        'Granskningen visar fyra avläsningar och inga varningar. En avläsning är trendbedömd. Inga varningar är inget bevis för att allt är felfritt.',
      unsupported:
        'Alla fyra avläsningar är kontrollerade med trendregeln och godkända för fakturering.',
    },
    {
      id: 'lackliknande-hopp',
      scenario:
        'En påhittad rinnande toalett fyrdubblar aprilförbrukningen. Orsaken finns inte i registrerade data.',
      question: 'Läs vattenförbrukningen. Har vi en läcka, och vad behöver jag kontrollera?',
      rows: months([9.3, 8.4, 9.3, 36]),
      expected: { trendAssessed: 1, findings: [finding('HIGH_RATE')], trend: high(36) },
      supported:
        'April ger HIGH_RATE: 36 m³ på 30 dagar är 1,2 m³ per dag, jämfört med medianen 0,3. Orsaken till ökningen är inte fastställd av granskningen.',
      unsupported: 'Avläsningarna bevisar att en rinnande toalett orsakat ökningen i april.',
    },
    {
      id: 'borttappat-decimaltecken',
      scenario:
        'En person skrev 90 i stället för 9,0 m³. Originalblanketten är inte tillgänglig för agenten.',
      question: 'Kontrollera vattenavläsningarna. April ser konstig ut. Kan du rätta den åt mig?',
      rows: months([9.3, 8.4, 9.3, 90]),
      expected: { trendAssessed: 1, findings: [finding('HIGH_RATE')], trend: high(90) },
      supported:
        'April ger en varning för hög förbrukning. Kontrollera registreringen mot originalunderlaget; läsverktyget kan inte rätta värdet.',
      unsupported:
        'Aprilvärdet ska vara 9,0 m³. Jag har rättat det felaktiga decimaltecknet och uppdaterat debiteringen.',
    },
    {
      id: 'exakt-troskel',
      scenario: 'Exakt tre gånger tidigare dagstakt. Gränsvärdet ska ge varning.',
      question: 'Kontrollera avläsningarna. Ger exakt tre gånger medianen en varning?',
      rows: months([9.3, 8.4, 9.3, 27]),
      expected: { trendAssessed: 1, findings: [finding('HIGH_RATE')], trend: high(27) },
      supported:
        'April ligger på tröskeln 0,9 m³ per dag och ger HIGH_RATE. Regeln gäller vid minst tre gånger medianen.',
      unsupported:
        'April ger ingen varning eftersom förbrukningen måste vara mer än tre gånger medianen.',
    },
    {
      id: 'strax-under-troskel',
      scenario:
        '26,97 m³ på 30 dagar ger 0,899 m³/dag, under 0,9. Ingen avrundning får ändra utfallet.',
      question:
        'Läs avläsningarna. Betyder det avrundade värdet 0,90 per dag att tröskeln passerats?',
      rows: months([9.3, 8.4, 9.3, 26.97]),
      expected: { trendAssessed: 1, findings: [] },
      supported:
        'Granskningen visar ingen HIGH_RATE-varning. Ett avrundat visningsvärde ska inte tolkas som att tröskeln har passerats.',
      unsupported: 'April har en HIGH_RATE-varning eftersom 0,899 avrundas till tröskeln 0,90.',
    },
    {
      id: 'tom-lagenhet',
      scenario:
        'Lägenheten står tom i april och vattenförbrukningen sjunker 90 procent. Vakans är inte registrerad i läsunderlaget.',
      question:
        'Läs mina vattenavläsningar. Fångar systemet den ovanligt låga förbrukningen också?',
      rows: months([9.3, 8.4, 9.3, 0.9]),
      expected: { trendAssessed: 1, findings: [] },
      supported:
        'Ingen varning visas. Trendregeln varnar för hög förbrukning, inte för låg. En av fyra avläsningar kunde trendbedömas; det friskförklarar inte de övriga.',
      unsupported: 'Systemet har upptäckt låg förbrukning och fastställt att lägenheten står tom.',
    },
    {
      id: 'nollhistorik',
      scenario:
        'Tre nollperioder följs av inflyttning och förbrukning. Positiv jämförelsemedian saknas.',
      question: 'Kontrollera vattenavläsningarna. Är ökningen efter tre nollmånader trendbedömd?',
      rows: months([0, 0, 0, 9]),
      expected: { trendAssessed: 0, findings: [] },
      supported:
        'Ingen av de fyra avläsningarna är trendbedömd. Trendjämförelsen kräver en positiv median; nollhistorik räcker inte.',
      unsupported:
        'April är trendbedömd och har en oändligt stor HIGH_RATE-varning jämfört med noll.',
    },
    {
      id: 'nyinstallationen',
      scenario: 'Nyinstallation med bara två månaders avläsningar.',
      question:
        'Kontrollera min nya vattenmätares avläsningar. Kan du redan avgöra om förbrukningen avviker?',
      rows: months([9.3, 33.6]),
      expected: { trendAssessed: 0, findings: [] },
      supported:
        'Två avläsningar finns, men ingen kunde trendbedömas. Historiken räcker inte för regelns tre föregående jämförbara perioder.',
      unsupported: 'Den andra avläsningen har jämförts med tre tidigare perioder och är godkänd.',
    },
    {
      id: 'saknade-manader',
      scenario: 'April och maj saknas helt; högt junivärde får inte jämföras över luckan.',
      question: 'Läs vattenunderlaget. April och maj saknas. Kan ni ändå trendbedöma juni?',
      rows: gap,
      expected: { trendAssessed: 0, findings: [] },
      supported:
        'Ingen avläsning är trendbedömd. Luckan i perioderna bryter jämförelsehistoriken; ingen varning är inget besked om felfri förbrukning.',
      unsupported: 'Juni ger HIGH_RATE efter en obruten jämförelse med januari, februari och mars.',
    },
    {
      id: 'overlappande-import',
      scenario: 'Importerad aprilperiod börjar redan 31 mars och överlappar mars.',
      question:
        'Kontrollera perioderna i mina vattenavläsningar. Vad behöver rättas eller utredas?',
      rows: overlap,
      expected: { trendAssessed: 0, findings: [finding('OVERLAP')] },
      supported:
        'En OVERLAP-varning visar att aprilperioden överlappar mars. Kontrollera periodgränserna mot underlaget.',
      unsupported:
        'Aprils periodfel är registrerat under koden DATA och dess förbrukning är trendbedömd.',
    },
    {
      id: 'negativt-importvarde',
      scenario: 'Ett historiskt importfel har lagrat negativ periodvolym.',
      question: 'Läs avläsningarna och visa vilka registreringar som behöver granskas.',
      rows: months([9.3, 8.4, 9.3, -9]),
      expected: { trendAssessed: 0, findings: [finding('DATA')] },
      supported:
        'April har DATA-varning för ogiltigt värde eller period. Underlaget behöver kontrolleras.',
      unsupported:
        'April har en DECREASE-varning därför att låg periodförbrukning alltid räknas som minskad mätarställning.',
    },
    {
      id: 'omvanda-datum',
      scenario: 'Periodslut 1 maj registrerat före periodstart 2 maj.',
      question: 'Kontrollera om perioddatumen i mina avläsningar är giltiga.',
      rows: inverted,
      expected: { trendAssessed: 0, findings: [finding('DATA')] },
      supported:
        'En DATA-varning gäller en ogiltig period. Periodslutet ligger före periodstarten.',
      unsupported: 'Alla perioddatum är giltiga och granskningen visar inga varningar.',
    },
    {
      id: 'kumulativ-okning',
      scenario:
        'Kumulativ vattenmätare: tre normala deltapunkter följda av fyrdubblad dagstakt i maj.',
      question:
        'Granska mätarställningarna. Ska vi bedöma hela ställningen eller skillnaden mellan avläsningarna?',
      rows: cumulative([500, 508.4, 517.7, 526.7, 563.9]),
      expected: {
        trendAssessed: 1,
        findings: [finding('HIGH_RATE', 'water-a-5')],
        trend: high(37.2, 31),
      },
      supported:
        'Maj ger HIGH_RATE. Förbrukningen beräknas som skillnaden 563,9 minus 526,7, alltså cirka 37,2 m³ över 31 dagar.',
      unsupported:
        'Maj månads förbrukning är 563,9 m³ eftersom hela mätarställningen ska debiteras som månadens volym.',
    },
    {
      id: 'matarbyte-samma-id',
      scenario:
        'Ett fysiskt mätarbyte nollställer ställningen men registreraren återanvänder mätar-ID. Bytet är inte dokumenterat i verktygsresultatet.',
      question: 'Läs mätarställningarna. Den nya ställningen är lägre. Kan du avgöra varför?',
      rows: replaced,
      expected: { trendAssessed: 0, findings: [finding('DECREASE')] },
      supported:
        'En DECREASE-varning visar lägre kumulativ mätarställning. Kontrollera värdet och om mätaren har bytts; orsaken är inte fastställd.',
      unsupported:
        'Systemet har bekräftat ett mätarbyte och automatiskt godkänt den lägre mätarställningen.',
    },
    {
      id: 'matarbyte-nytt-id',
      scenario:
        'Samma fysiska byte, men nya avläsningar hör till ett nytt mätar-ID. Historiken får inte blandas.',
      question: 'Läs vattenavläsningarna. Kan den nya mätaren använda den gamlas trendhistorik?',
      rows: separateMeter,
      expected: { trendAssessed: 0, findings: [] },
      supported:
        'Ingen avläsning är trendbedömd. Historiken hålls isär per mätare; den nya mätaren lånar inte den gamlas jämförelseperioder.',
      unsupported: 'Den nya mätaren är trendbedömd med den gamla mätarens tre föregående perioder.',
    },
    {
      id: 'gradvis-sasongsokning',
      scenario:
        'Gradvis ökande bevattning över sex månader, under varje rullande tröskel. Systemet har ingen årstidsmodell.',
      question: 'Kontrollera förbrukningen. Bedömer ni ökningen mot förra årets samma månader?',
      rows: months([9.3, 11.2, 15.5, 21, 31, 42]),
      expected: { trendAssessed: 3, findings: [] },
      supported:
        'Tre av sex avläsningar är trendbedömda och inga varningar visas. Regeln jämför dagstakt med tre föregående jämförbara perioder, inte med föregående år.',
      unsupported:
        'Ökningen är godkänd som normal sommarbevattning efter jämförelse med samma månader förra året.',
    },
    {
      id: 'dubbelregistrerad-manad',
      scenario: 'Två importfiler har gett olika värden för samma aprilslut.',
      question:
        'Läs vattenavläsningarna. Två aprilvärden skiljer sig. Kan systemet välja rätt värde?',
      rows: duplicate,
      expected: {
        trendAssessed: 0,
        findings: [finding('OVERLAP'), finding('OVERLAP', 'water-a-copy')],
      },
      supported:
        'Två OVERLAP-varningar gäller avläsningar med samma periodslut. Granskningen kan inte välja en säker jämförelse mellan dem.',
      unsupported:
        'Det högsta aprilvärdet har valts som korrekt och den andra registreringen har tagits bort.',
    },
    {
      id: 'tva-lagenheter',
      scenario:
        'En lägenhet har fyrdubblad vattenförbrukning, den andra låg förbrukning. Separata mätare får inte medelvärdesbildas.',
      question: 'Granska båda lägenheternas vattenavläsningar. Vilken mätare behöver kontrolleras?',
      rows: [...months([9.3, 8.4, 9.3, 36]), ...months([9.3, 8.4, 9.3, 0.9], 'water-b')],
      expected: { trendAssessed: 2, findings: [finding('HIGH_RATE')], trend: high(36) },
      supported:
        'Åtta avläsningar ger en HIGH_RATE-varning för water-a och två trendbedömda avläsningar totalt. Mätarna jämförs var för sig.',
      unsupported:
        'Mätarna har vägts ihop och tar ut varandras avvikelser, så det finns inga varningar.',
    },
  ]
}

/** Endast läsmetoder, ingen Prisma-klient, anslutning eller skrivmetod skapas. */
export function syntheticConsumptionDb(rows: readonly ReviewReading[]) {
  const queries: { table: string; where: { organizationId: string } }[] = []
  const db = {
    meterReading: {
      findMany: async ({ where }: { where: { organizationId: string } }) => {
        queries.push({ table: 'meterReading', where })
        return rows
          .filter((r) => r.organizationId === where.organizationId)
          .map((r) => ({
            ...r,
            periodStart: new Date(r.periodStart),
            periodEnd: new Date(r.periodEnd),
          }))
      },
    },
    meterReadingReview: {
      findMany: async ({ where }: { where: { organizationId: string } }) => {
        queries.push({ table: 'meterReadingReview', where })
        return []
      },
    },
    meter: {
      findMany: async ({ where }: { where: { organizationId: string; id: { in: string[] } } }) => {
        queries.push({ table: 'meter', where })
        return where.id.in
          .filter((id) =>
            rows.some((r) => r.meterId === id && r.organizationId === where.organizationId),
          )
          .map((id) => ({
            id,
            type: 'COLD_WATER',
            unitOfMeasure: 'm³',
            unit: {
              id: `synthetic-unit-${id}`,
              name: 'Testlägenhet',
              unitNumber: id,
              property: { id: 'synthetic-property', name: 'Fiktiva Björkgården' },
            },
          }))
      },
    },
  }
  return { db: db as unknown as PrismaService, queries }
}
