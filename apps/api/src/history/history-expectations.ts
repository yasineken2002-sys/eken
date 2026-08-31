/**
 * FÖRVÄNTNINGARNA — och var de kommer ifrån.
 *
 * ── EN LUCKA ÄR ETT BERÄKNAT TILLSTÅND ──────────────────────────────────────
 *
 * Frånvaro finns inte i en händelselogg. En lucka uppstår först när något
 * FÖRVÄNTAT inte hänt, och den får därför aldrig lagras som en flagga — samma
 * princip som redan bär systemet: *skuld är ett beräknat tillstånd*.
 *
 * ── DÄRFÖR MÅSTE FÖRVÄNTAN HA EN KÄLLA ──────────────────────────────────────
 *
 * En beräknad lucka är bara så sann som förväntan den mäts mot. Skriver någon
 * "besiktning vartannat år" i koden har systemet fått en regel ingen bestämt,
 * och den kommer att larma på hyresvärdar som aldrig gått med på den. Därför
 * bär varje förväntan här en `källa`, och den kan bara vara tre saker:
 *
 *   KONFIGURERAD  — ett fält i databasen som en människa satt. Anges med
 *                   modell och fält, så påståendet går att kontrollera.
 *   SYSTEMREGEL   — en regel som redan STYR systemets beteende, med
 *                   kodhänvisning. Inte en åsikt om hur det borde vara.
 *   ODEFINIERAD   — ingen förväntan finns. Då beräknas ingen lucka, och det
 *                   SKRIVS UT.
 *
 * ── DEN TREDJE ÄR HELA POÄNGEN ──────────────────────────────────────────────
 *
 * "Inget saknas" och "vi vet inte vad som borde ha hänt" ser likadana ut i en
 * tom lista. Skillnaden är avgörande för den som litar på svaret, och den är
 * exakt den tystnad som gjort de andra defekterna i det här projektet dyra.
 * En ODEFINIERAD förväntan returneras därför som ett eget utfall, inte som
 * frånvaro.
 *
 * ── VAD MÄTNINGEN 2026-08-31 VISADE ─────────────────────────────────────────
 *
 * Ett svep över `schema.prisma` efter fält som uttrycker ett intervall eller en
 * frekvens gav TRE träffar: `Lease.renewalPeriodMonths`, `Lease.noticePeriodMonths`
 * och `MaintenancePlan.interval`. De två första är uppsägnings- och
 * förlängningstider, inte återkommande förväntningar.
 *
 * Det betyder att planens EGNA två exempel på luckor — *"ingen besiktning sedan
 * 2023"* och *"ingen avläsning på åtta månader"* — saknar konfigurerad förväntan
 * i systemet. Ingen har hittats på åt dem. De redovisas som ODEFINIERADE, vilket
 * är det ärliga svaret och dessutom en användbar upplysning: vill hyresvärden ha
 * den bevakningen måste intervallet först bli något hen kan ställa in.
 */

/** Var förväntan kommer ifrån. Utan detta är en lucka en gissning. */
export type ExpectationSource =
  | {
      kind: 'KONFIGURERAD'
      /** `Modell.fält` — så påståendet går att kontrollera mot schemat. */
      field: string
      description: string
    }
  | {
      kind: 'SYSTEMREGEL'
      /** Fil och funktion som REDAN styr beteendet. */
      rule: string
      description: string
    }
  | {
      kind: 'ODEFINIERAD'
      /** Vad som saknas, och vad som skulle krävas för att definiera den. */
      why: string
    }

export interface ExpectationDefinition {
  key: string
  /** Vad förväntan handlar om, på svenska. */
  label: string
  source: ExpectationSource
}

/**
 * Alla förväntningar historiken känner till — inklusive de odefinierade.
 *
 * De odefinierade står HÄR och inte som en kommentar någon annanstans, av
 * samma skäl som `history-sources.ack.json` finns: ett medvetet "nej" ska vara
 * en rad i en fil, inte en tystnad.
 */
export const HISTORY_EXPECTATIONS: readonly ExpectationDefinition[] = [
  {
    key: 'rent-notice-per-month',
    label: 'Hyresavi för varje månad avtalet löpt',
    source: {
      kind: 'SYSTEMREGEL',
      rule: 'avisering.service.ts → generateMonthlyNotices()',
      description:
        'Aviseringen genererar en RENT-avi per (avtal, år, månad) för avtal med status ' +
        'ACTIVE, samt EXPIRED med endDate i eller efter genereringsmånaden. Körningen är ' +
        'idempotent på just den nyckeln. Förväntan är alltså inte en åsikt om hur ofta ' +
        'hyra ska aviseras — den är vad systemet redan gör.',
    },
  },
  {
    key: 'scheduled-inspection-completed',
    label: 'Planerad besiktning blir utförd',
    source: {
      kind: 'KONFIGURERAD',
      field: 'Inspection.scheduledDate',
      description:
        'Datumet är satt av en människa för just den besiktningen. Förväntan är därför ' +
        'per rad och behöver inget intervall: har dagen passerat utan att besiktningen ' +
        'utförts är det en lucka. Notera skillnaden mot ett BESIKTNINGSINTERVALL, som ' +
        'inte finns — se nedan.',
    },
  },
  {
    key: 'maintenance-plan-interval',
    label: 'Planerat underhåll utfört inom sitt intervall',
    source: {
      kind: 'KONFIGURERAD',
      field: 'MaintenancePlan.interval + MaintenancePlan.lastDoneYear',
      description:
        'Enda återkommande intervallet som går att ställa in i systemet. Uttryckt i år, ' +
        'vilket följer av att grannfälten är `plannedYear` och `lastDoneYear`. Gäller ' +
        'fastigheten, och därmed varje hyresgäst i den.',
    },
  },
  {
    key: 'equipment-lifespan',
    label: 'Utrustning inom sin förväntade livslängd',
    source: {
      kind: 'KONFIGURERAD',
      field: 'UnitEquipment.expectedLifespanYears + UnitEquipment.installedAt',
      description:
        'Andra konfigurerade återkommande förväntan i systemet, och den första på ' +
        'OBJEKTNIVÅ. Fältet är nullbart utan default: ett tal måste komma från en ' +
        'människa, annars vore förväntan påhittad av koden. Är fältet null för ett ' +
        'objekt kan ingen lucka beräknas för DET objektet, och utfallet blir ' +
        'ODEFINIERAD — aldrig "ingen lucka".',
    },
  },
  {
    key: 'equipment-service-interval',
    label: 'Utrustning servad inom sitt intervall',
    source: {
      kind: 'KONFIGURERAD',
      field: 'UnitEquipment.serviceIntervalMonths + senaste SERVICED-händelse',
      description:
        'Räknas från senaste `UnitEquipmentEvent` med typ SERVICED, eller från ' +
        '`installedAt` om objektet aldrig servats — en nyinstallerad sak är inte ' +
        'försenad för att den ännu inte servats. Samma nullregel som livslängden.',
    },
  },
  {
    key: 'inspection-interval',
    label: 'Återkommande besiktning med visst intervall',
    source: {
      kind: 'ODEFINIERAD',
      why:
        'Inget fält i schemat och ingen regel i koden anger hur ofta en lägenhet ska ' +
        'besiktigas. Planens exempel "ingen besiktning sedan 2023" går därför inte att ' +
        'beräkna. Att välja ett intervall här vore att ge systemet en regel ingen ' +
        'bestämt. Krävs för att definiera den: ett konfigurerbart intervall per ' +
        'fastighet eller objekt.',
    },
  },
  {
    key: 'meter-reading-interval',
    label: 'Mätaravläsning med visst intervall',
    source: {
      kind: 'ODEFINIERAD',
      why:
        '`Meter` bär `installedAt` och `status` men ingen avläsningsfrekvens, och ingen ' +
        'kodväg räknar en förfallen avläsning. Planens exempel "ingen avläsning på åtta ' +
        'månader" går därför inte att beräkna. Krävs: ett intervallfält på `Meter`, ' +
        'rimligen per mätartyp.',
    },
  },
  {
    key: 'maintenance-ticket-response',
    label: 'Felanmälan får återkoppling inom rimlig tid',
    source: {
      kind: 'ODEFINIERAD',
      why:
        'Ingen svarstid är konfigurerad någonstans. `MaintenanceTicket` har `priority` ' +
        'men ingen frist knuten till den. Planens exempel "ärende öppet i tre veckor ' +
        'utan återkoppling" går därför inte att beräkna. Krävs: en frist per ' +
        'prioritetsnivå, satt av organisationen.',
    },
  },
]
