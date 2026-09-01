import { ACTION_TOOLS } from './ai-tools.definition'

/**
 * EFFEKTKLASSIFICERINGEN — vad varje bindande verktygs effekt TÅL.
 *
 * ── VARFÖR DEN FINNS FÖRE NYCKLARNA ─────────────────────────────────────────
 *
 * En återupptagningsmotor måste kunna fråga "får det här köras om?" innan den
 * kör om något. Utan en maskinläsbar klassificering finns ingen att fråga, och
 * felriktningen är asymmetrisk: att något ODEDUPLICERBART ser ut som klass (i)
 * skickar dubbla brev, medan motsatt fel bara skapar onödigt arbete åt en
 * människa. Deklarationen är billigast och bär allt annat.
 *
 * ── ANSPRÅK OCH IDEMPOTENS SVARAR PÅ OLIKA FRÅGOR ───────────────────────────
 *
 * `AiPendingAction` svarar på VEM SOM FICK GÖRA DET: anspråket tas atomiskt
 * (`ai-assistant.service.ts`, `updateMany({ where: { consumedAt: null } })`) och
 * avgör vem av två samtidiga bekräftelser som vinner.
 *
 * Den kan INTE svara på om det blev gjort, och det är strukturellt: `consumedAt`
 * sätts FÖRE utförandet, så tillståndet "förbrukat" är tvetydigt mellan *gjort*
 * och *påbörjat men kraschat*. Ingen utökning av anspråket löser det, eftersom
 * anspråket per definition skrivs innan effekten finns.
 *
 * Kraschåterupptagning är alltså en EFFEKT-fråga. Den här filen deklarerar vad
 * effekten tål; anspråket lämnas orört.
 *
 * ── IDEMPOTENSENS ENHET ÄR INTE ALLTID ANROPET ──────────────────────────────
 *
 * `send_overdue_reminders` och `compose_and_send_email` är LOOPAR med `try/catch`
 * per mottagare och en `sent++`-räknare. Kraschar en av dem efter 25 av 40 säger
 * en nyckel på ANROPET antingen "gjort" — och 15 personer får aldrig sitt brev —
 * eller "inte gjort" — och 25 får det två gånger. Båda är fel. Därför bär varje
 * post `idempotencyUnit`, och loopverktygen står som `EFFEKT`.
 *
 * ── VAD SOM ÄR MÄTT, OCH NÄR ────────────────────────────────────────────────
 *
 * Klassningen är härledd ur KODEN 2026-09-01, verktyg för verktyg — inte ur
 * namnen. Motiveringen står som kommentar över varje post med den mekanism som
 * bär den. `check-effect-idempotency.mjs` prövar att mekanismen fortfarande
 * finns; en deklaration som ingen prövar är en kommentar.
 *
 * Talen, mätta samma dag mot `ACTION_TOOLS` (30 verktyg):
 *
 *     IDEMPOTENT      16   (varav 1 utan effekt alls: export_sie4)
 *     DEDUPLICERBAR   14   (varav 1 har en nyckel som faktiskt dedupar)
 *     OKÄND            0
 *     oåterkalleliga och omöjliga att avduplicera:  0
 *
 * Nollan sist är den viktiga: problemet är mekaniskt lösbart. Men den gäller
 * bara inom spårets livslängd — se `KÖ_FÖNSTER` nedan.
 */

/**
 * Vad effekten tål vid en omkörning.
 *
 *  • `IDEMPOTENT`    — en omkörning ger SAMMA tillstånd. Något i koden bär det
 *                      (unikt index, statusmaskin, innehållshash), och
 *                      `mekanismer` namnger vad.
 *  • `DEDUPLICERBAR` — effekten är envägs, men en post KAN konsulteras före
 *                      utförandet. Att den kan betyder inte att den gör det:
 *                      `traceDurability` säger om spåret finns i dag.
 *  • `OKÄND`         — inte klassificerad. Betyder ALDRIG "antagligen okej".
 *                      Fail-closed: får aldrig återupptas automatiskt.
 */
export type EffectIdempotency = 'IDEMPOTENT' | 'DEDUPLICERBAR' | 'OKÄND'

/** Vad idempotensen är nycklad på: hela anropet, eller varje enskild effekt. */
export type IdempotencyUnit = 'ANROP' | 'EFFEKT'

/**
 * POLICY, inte mekanik. `mark_sent_to_collection` är mekaniskt `IDEMPOTENT` och
 * står ändå `KRÄVER_MÄNNISKA`: den skriver en permanent DEBT_COLLECTION-post mot
 * en enskild person. Att något är säkert att köra om betyder inte att en maskin
 * bör göra det.
 */
export type ResumptionPolicy = 'AUTOMATISK' | 'KRÄVER_MÄNNISKA'

/**
 * Var spåret bor och hur länge det överlever.
 *
 * `KÖ_FÖNSTER` är det farliga värdet. `mail.queue.ts` sätter
 * `removeOnComplete: { age: 7 dygn, count: 1000 }` — och **`count`-taket biter
 * före ålderstaket**: en organisation som skickar 1000 mejl på två dagar har
 * tappat sina äldsta `jobId` långt före dag sju. Ett spår i kön är alltså inte
 * ett spår som överlever en fördröjd återupptagning.
 */
export interface TraceDurability {
  plats:
    | 'DATABAS_INDEX'
    | 'DATABAS_TILLSTÅND'
    | 'DATABAS_HASH'
    | 'KÖ_FÖNSTER'
    | 'INGET'
    | 'EJ_TILLÄMPLIG'
  /** Hur länge spåret överlever, i klartext. */
  livslangd: string
}

/**
 * Mekanismen som BÄR en påstådd idempotens — vaktens kontrollpunkt.
 *
 * ⚠️ VAD VAKTEN FAKTISKT KAN PRÖVA, och vad den inte kan:
 *
 *  • `UNIKT_INDEX` prövas SEMANTISKT: indexet finns över exakt de fälten i
 *    `schema.prisma`, eller så faller vakten. Det är den starka regeln.
 *  • `INNEHÅLLSHASH`, `STATUSGRIND` och `REN_UPPDATERING` prövas som
 *    DRIFTDETEKTERING: den namngivna symbolen finns kvar i den namngivna filen,
 *    i kod och inte i prosa. Det fångar att någon raderar eller döper om
 *    grinden — inte att någon försvagar den inifrån.
 *
 * Skillnaden står här med flit. En vakt vars räckvidd man tror är större än den
 * är kostar lika mycket som en som saknas.
 */
export type Mekanism =
  | { typ: 'INGEN_EFFEKT' }
  | { typ: 'UNIKT_INDEX'; modell: string; falt: string[] }
  | { typ: 'INNEHÅLLSHASH'; fil: string; symbol: string }
  | { typ: 'STATUSGRIND'; fil: string; symbol: string }
  | { typ: 'REN_UPPDATERING'; fil: string; symbol: string }

export interface EffectDeclaration {
  effectIdempotency: EffectIdempotency
  idempotencyUnit: IdempotencyUnit
  traceDurability: TraceDurability
  resumptionPolicy: ResumptionPolicy
  /**
   * Har policyn FATTATS, eller står värdet där konservativt i väntan på ett
   * beslut? `false` tvingar `KRÄVER_MÄNNISKA` — annars hade "ingen har tänkt på
   * det här än" sett ut som "en människa behövs", och de två är olika saker.
   */
  policyBeslutad: boolean
  /** Tom lista är tillåten BARA när effectIdempotency inte är IDEMPOTENT. */
  mekanismer: Mekanism[]
}

const DB_RAD = 'så länge raden finns (räkenskapsinformation bevaras 7 år)'
const KO_FONSTER = 'Bull jobId: 7 dygn ELLER 1000 jobb — det som infaller först'

export const EFFECT_DECLARATIONS: Record<string, EffectDeclaration> = {
  // ══ IDEMPOTENT ═══════════════════════════════════════════════════════════

  // Ren läsning: bygger en SIE4-buffert och returnerar den. Enda av de 30 som
  // står utanför EFFECT_PRODUCING_TOOLS — det finns ingen effekt att återuppta.
  export_sie4: {
    effectIdempotency: 'IDEMPOTENT',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'EJ_TILLÄMPLIG', livslangd: 'ingen effekt att spåra' },
    resumptionPolicy: 'AUTOMATISK',
    policyBeslutad: true,
    mekanismer: [{ typ: 'INGEN_EFFEKT' }],
  },

  // RentNotice @@unique([leaseId, year, month, type]) OCH ett explicit
  // existingLeaseIds-skip i generateMonthlyNotices → `skipped`-räknare.
  // Skyddet ligger per avi, inte per anrop: därför EFFEKT.
  generate_rent_notices: {
    effectIdempotency: 'IDEMPOTENT',
    idempotencyUnit: 'EFFEKT',
    traceDurability: { plats: 'DATABAS_INDEX', livslangd: DB_RAD },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [
      { typ: 'UNIKT_INDEX', modell: 'RentNotice', falt: ['leaseId', 'year', 'month', 'type'] },
    ],
  },

  // Delad ingest-kärna: fält-dedup (org, date, amount, rawOcr) via `crossSource`
  // → { duplicate: true }, ingen create. En omimport räknar upp `duplicates`.
  // Dedupen sker per transaktion i filen → EFFEKT.
  import_bgmax_file: {
    effectIdempotency: 'IDEMPOTENT',
    idempotencyUnit: 'EFFEKT',
    traceDurability: { plats: 'DATABAS_TILLSTÅND', livslangd: DB_RAD },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [
      {
        typ: 'STATUSGRIND',
        fil: 'apps/api/src/reconciliation/reconciliation.service.ts',
        symbol: 'crossSource',
      },
    ],
  },

  // InvoicePayment.bankTransactionId @unique — schemat kallar den rakt ut
  // "dubbel-allokeringsskyddet: en bank-transaktion kan allokeras till EXAKT en
  // faktura". En omkörning kolliderar.
  match_bank_transaction: {
    effectIdempotency: 'IDEMPOTENT',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'DATABAS_INDEX', livslangd: DB_RAD },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [{ typ: 'UNIKT_INDEX', modell: 'InvoicePayment', falt: ['bankTransactionId'] }],
  },

  // `if (transaction.status !== 'MATCHED') throw` — en omkörning mot en redan
  // hävd matchning avvisas.
  unmatch_transaction: {
    effectIdempotency: 'IDEMPOTENT',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'DATABAS_TILLSTÅND', livslangd: DB_RAD },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [
      {
        typ: 'STATUSGRIND',
        fil: 'apps/api/src/reconciliation/reconciliation.service.ts',
        symbol: 'unmatchTransaction',
      },
    ],
  },

  // Unit @@unique([propertyId, unitNumber]) → en omkörning med samma nummer
  // kolliderar i stället för att skapa en andra lägenhet.
  create_unit: {
    effectIdempotency: 'IDEMPOTENT',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'DATABAS_INDEX', livslangd: DB_RAD },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [{ typ: 'UNIKT_INDEX', modell: 'Unit', falt: ['propertyId', 'unitNumber'] }],
  },

  // sourceId = ai:<innehållshash> + JournalEntry @@unique([organizationId,
  // source, sourceId]). Sedan #597 returnerar även ett SAMTIDIGT omförsök det
  // första verifikatet i stället för att kasta P2002.
  create_journal_entry: {
    effectIdempotency: 'IDEMPOTENT',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'DATABAS_HASH', livslangd: DB_RAD },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [
      {
        typ: 'INNEHÅLLSHASH',
        fil: 'apps/api/src/ai/tools/ai-journal-source.ts',
        symbol: 'aiJournalSourceId',
      },
      {
        typ: 'UNIKT_INDEX',
        modell: 'JournalEntry',
        falt: ['organizationId', 'source', 'sourceId'],
      },
    ],
  },

  // Samma mekanism som create_journal_entry.
  record_expense: {
    effectIdempotency: 'IDEMPOTENT',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'DATABAS_HASH', livslangd: DB_RAD },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [
      {
        typ: 'INNEHÅLLSHASH',
        fil: 'apps/api/src/ai/tools/ai-journal-source.ts',
        symbol: 'aiJournalSourceId',
      },
      {
        typ: 'UNIKT_INDEX',
        modell: 'JournalEntry',
        falt: ['organizationId', 'source', 'sourceId'],
      },
    ],
  },

  // signing.service.ts härleder sha256(documentId + contentHash) och dedupar
  // atomärt mot SigningRequest @@unique([organizationId, idempotencyKey]).
  // Verktyget skickar ingen nyckel — tjänsten härleder den själv, vilket är
  // varför den här redan är löst utan att någon räknade den.
  prepare_contract_signing: {
    effectIdempotency: 'IDEMPOTENT',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'DATABAS_HASH', livslangd: DB_RAD },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [
      {
        typ: 'INNEHÅLLSHASH',
        fil: 'apps/api/src/signing/signing.service.ts',
        symbol: 'idempotencyKey',
      },
      {
        typ: 'UNIKT_INDEX',
        modell: 'SigningRequest',
        falt: ['organizationId', 'idempotencyKey'],
      },
    ],
  },

  // Ren update med absoluta värden — ingen append, ingen increment. Samma
  // indata ger samma tillstånd.
  update_tenant: {
    effectIdempotency: 'IDEMPOTENT',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'DATABAS_TILLSTÅND', livslangd: DB_RAD },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [
      { typ: 'REN_UPPDATERING', fil: 'apps/api/src/tenants/tenants.service.ts', symbol: 'update' },
    ],
  },

  // Sätter remindersPaused: true. ⚠️ remindersPausedAt sätts till new Date()
  // vid varje körning — det AFFÄRSMÄSSIGA tillståndet är idempotent, men
  // tidsstämpeln driver. Noterat, inte dolt.
  pause_reminders: {
    effectIdempotency: 'IDEMPOTENT',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'DATABAS_TILLSTÅND', livslangd: DB_RAD },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [
      {
        typ: 'REN_UPPDATERING',
        fil: 'apps/api/src/notifications/payment-reminder.service.ts',
        symbol: 'remindersPaused',
      },
    ],
  },

  resume_reminders: {
    effectIdempotency: 'IDEMPOTENT',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'DATABAS_TILLSTÅND', livslangd: DB_RAD },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [
      {
        typ: 'REN_UPPDATERING',
        fil: 'apps/api/src/notifications/payment-reminder.service.ts',
        symbol: 'resumeReminders',
      },
    ],
  },

  // `if (pre.alreadyClosed) throw ConflictException('redan stängd')` plus en
  // kollisionsfångst på skrivningen. En omkörning skapar ingen andra stängning.
  close_period: {
    effectIdempotency: 'IDEMPOTENT',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'DATABAS_TILLSTÅND', livslangd: DB_RAD },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [
      {
        typ: 'STATUSGRIND',
        fil: 'apps/api/src/accounting/accounting-period.service.ts',
        symbol: 'alreadyClosed',
      },
    ],
  },

  // Atomär, status-grindad claim (#307). transitionBlockReason ur statusmaskinen
  // avvisar en omkörning.
  export_for_collection: {
    effectIdempotency: 'IDEMPOTENT',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'DATABAS_TILLSTÅND', livslangd: DB_RAD },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [
      {
        typ: 'STATUSGRIND',
        fil: 'apps/api/src/collections/collection-export.service.ts',
        symbol: 'transitionBlockReason',
      },
    ],
  },

  // Mekaniskt samma spärr som export_for_collection — OCH ändå KRÄVER_MÄNNISKA,
  // beslutat. Den skriver en permanent DEBT_COLLECTION-post mot en enskild
  // person. Mekaniken säger att det är säkert att köra om; det är inte samma
  // sak som att en maskin bör göra det.
  mark_sent_to_collection: {
    effectIdempotency: 'IDEMPOTENT',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'DATABAS_TILLSTÅND', livslangd: DB_RAD },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: true,
    mekanismer: [
      {
        typ: 'STATUSGRIND',
        fil: 'apps/api/src/collections/collection-export.service.ts',
        symbol: 'transitionBlockReason',
      },
    ],
  },

  // assertLeaseTransition spärrar ogiltiga övergångar. ACTIVE→TERMINATED
  // delegerar till terminate(), som lämnar status ACTIVE — men terminate() har
  // sin EGEN spärr: `if (lease.terminatedAt) throw 'Kontraktet är redan
  // uppsagt'`. Utan den hade en omkörning räknat om slutdatumet från NYTT datum.
  transition_lease_status: {
    effectIdempotency: 'IDEMPOTENT',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'DATABAS_TILLSTÅND', livslangd: DB_RAD },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [
      {
        typ: 'STATUSGRIND',
        fil: 'apps/api/src/leases/leases.service.ts',
        symbol: 'assertLeaseTransition',
      },
      {
        typ: 'STATUSGRIND',
        fil: 'apps/api/src/leases/leases.service.ts',
        symbol: 'terminatedAt',
      },
    ],
  },

  // ══ DEDUPLICERBAR ════════════════════════════════════════════════════════

  // Har en RIKTIG nyckel: `invoice-send-${id}` → Bulls jobId + Resends
  // Idempotency-Key. Den dedupar en omkörning — men bara inom köns fönster.
  send_invoice_email: {
    effectIdempotency: 'DEDUPLICERBAR',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'KÖ_FÖNSTER', livslangd: KO_FONSTER },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [],
  },

  // ⚠️ FALSK SPÄRR. Nyckeln `doc-portal-notify-${documentId}` finns, men
  // documentId MYNTAS i samma körning som mejlet — se document-delivery.service.ts.
  // Den dedupar Bull-retries, aldrig ett agentomförsök. Spåret är INGET.
  send_document_to_tenant: {
    effectIdempotency: 'DEDUPLICERBAR',
    idempotencyUnit: 'ANROP',
    traceDurability: {
      plats: 'INGET',
      livslangd: 'nyckeln finns men är unik per körning — dedupar inget omförsök',
    },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [],
  },

  // LOOP över förfallna fakturor, try/catch per mottagare, sent++. Ingen nyckel
  // alls skickas till mailService. Enheten MÅSTE bli EFFEKT.
  send_overdue_reminders: {
    effectIdempotency: 'DEDUPLICERBAR',
    idempotencyUnit: 'EFFEKT',
    traceDurability: { plats: 'INGET', livslangd: 'inget spår finns' },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [],
  },

  // LOOP över hyresgäster. 15-min bulk-cooldown i Redis vid >5 mottagare är ett
  // trubbigt takt-skydd, inte idempotens: den blockerar ett LEGITIMT omförsök
  // och släpper igenom ett efter 15 minuter.
  compose_and_send_email: {
    effectIdempotency: 'DEDUPLICERBAR',
    idempotencyUnit: 'EFFEKT',
    traceDurability: { plats: 'INGET', livslangd: 'inget spår finns' },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [],
  },

  // PDF → R2 → Document.create. Document saknar unikt index; en omkörning ger
  // ett andra dokument. Document.contentHash finns redan och vore nyckeln.
  generate_lease_contract: {
    effectIdempotency: 'DEDUPLICERBAR',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'INGET', livslangd: 'inget spår finns' },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [],
  },

  // invoiceNumber allokeras ur en sekvens → varje omkörning får ett NYTT nummer
  // och blir en ny faktura. Sekvensnumret är motsatsen till en idempotensnyckel.
  create_invoice: {
    effectIdempotency: 'DEDUPLICERBAR',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'INGET', livslangd: 'inget spår finns' },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [],
  },

  // contractNumber ur sekvens — samma sak som create_invoice.
  create_lease: {
    effectIdempotency: 'DEDUPLICERBAR',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'INGET', livslangd: 'inget spår finns' },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [],
  },

  // Skapar BÅDE hyresgäst och avtal. Sekvensnumret gäller avtalet; hyresgästen
  // har ingen unik nyckel på namn/e-post.
  create_tenant_and_lease: {
    effectIdempotency: 'DEDUPLICERBAR',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'INGET', livslangd: 'inget spår finns' },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [],
  },

  // Property saknar unikt index helt — inte ens namn eller beteckning.
  create_property: {
    effectIdempotency: 'DEDUPLICERBAR',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'INGET', livslangd: 'inget spår finns' },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [],
  },

  // ticketNumber ur sekvens. ⚠️ Nämnaren är svår här: två identiska felanmälningar
  // på samma lägenhet samma dag KAN vara två verkliga fel. En innehållshash med
  // för grov nämnare gör tyst bortfall av det andra.
  create_maintenance_ticket: {
    effectIdempotency: 'DEDUPLICERBAR',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'INGET', livslangd: 'inget spår finns' },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [],
  },

  // Inspection saknar unikt index.
  create_inspection: {
    effectIdempotency: 'DEDUPLICERBAR',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'INGET', livslangd: 'inget spår finns' },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [],
  },

  // RentIncrease saknar unikt index. create() validerar bara 3-månadersbufferten
  // och att ny hyra > nuvarande — BÅDA passerar vid en omkörning, eftersom
  // lease-hyran inte skrivs om vid schemaläggningen. Två schemalagda höjningar.
  apply_rent_increase: {
    effectIdempotency: 'DEDUPLICERBAR',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'INGET', livslangd: 'inget spår finns' },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [],
  },

  // BLANDAD. Statusdelen är en ren update och idempotent; men addComment
  // APPENDAR, så en omkörning lägger kommentaren en andra gång. Den svagaste
  // halvan bestämmer klassen.
  update_maintenance_status: {
    effectIdempotency: 'DEDUPLICERBAR',
    idempotencyUnit: 'EFFEKT',
    traceDurability: { plats: 'INGET', livslangd: 'inget spår för kommentaren' },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [],
  },

  // FULL betalning spärras ('Fakturan är redan betald'). Men verktyget tar ett
  // `amount`, och en DELBETALNING kan köras om: manuella InvoicePayment har
  // bankTransactionId = NULL, och NULL är distinkt i det unika indexet.
  // Restskulden finns kvar, så assertPaymentWithinDebt släpper igenom den.
  mark_invoice_paid: {
    effectIdempotency: 'DEDUPLICERBAR',
    idempotencyUnit: 'ANROP',
    traceDurability: {
      plats: 'INGET',
      livslangd: 'fullbetalning spärras av status; delbetalning har inget spår',
    },
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: false,
    mekanismer: [],
  },
}

export interface EffectCatalogEntry extends EffectDeclaration {
  name: string
  /**
   * Får den här effekten återupptas automatiskt efter en krasch?
   *
   * FAIL-CLOSED, med tre villkor som ALLA måste hålla. `DEDUPLICERBAR` utan
   * spår faller på det tredje: att effekten *kan* dedupliceras hjälper ingen
   * förrän något faktiskt gör det.
   */
  autoResumable: boolean
}

function autoResumable(d: EffectDeclaration): boolean {
  if (d.effectIdempotency === 'OKÄND') return false
  if (d.resumptionPolicy !== 'AUTOMATISK') return false
  return d.traceDurability.plats !== 'INGET'
}

/**
 * Bygger katalogen ur `ACTION_TOOLS`. Kastar hellre än att gissa — samma
 * fail-closed-hållning som `buildToolCatalog()`, och av samma skäl: ett nytt
 * verktyg utan post ska stoppa bygget, inte tyst bli återupptagbart.
 */
export function buildEffectCatalog(): EffectCatalogEntry[] {
  return [...ACTION_TOOLS].map((name) => {
    const d = EFFECT_DECLARATIONS[name]
    if (!d) {
      throw new Error(
        `Verktyget "${name}" saknar effektklassificering i EFFECT_DECLARATIONS ` +
          `(apps/api/src/ai/tools/effect-idempotency.ts). Klassificera det — ` +
          `ett oklassat verktyg får inte vara återupptagbart, och det finns ingen ` +
          `tyst fallback att luta sig mot.`,
      )
    }
    return { name, ...d, autoResumable: autoResumable(d) }
  })
}

/**
 * Får verktyget återupptas automatiskt? FAIL-CLOSED i båda riktningarna: ett
 * OKÄNT verktygsnamn KASTAR i stället för att svara `false`, eftersom ett
 * tyst `false` hade dolt att anroparen frågar om något som inte finns.
 */
export function isAutoResumable(toolName: string): boolean {
  const d = EFFECT_DECLARATIONS[toolName]
  if (!d) {
    throw new Error(
      `Okänt verktyg "${toolName}" — ingen effektklassificering finns. ` +
        `Frågan går inte att besvara, och ett tyst "nej" hade dolt att den ställdes fel.`,
    )
  }
  return autoResumable(d)
}

/** Exponeras för vakten och specen som prövar att katalogen inte glider isär. */
export const EFFECT_DECLARATION_NAMES = Object.keys(EFFECT_DECLARATIONS)
