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
 *
 * ── POLICYN, SATT 2026-09-01 ────────────────────────────────────────────────
 *
 *     KRÄVER_MÄNNISKA  15      AUTOMATISK  15
 *     policybeslutade  30      obeslutade   0
 *     faktiskt återupptagbara i dag: 10
 *
 * Tre poster stod obeslutade en runda och avgjordes efter mätning:
 * `unmatch_transaction` (premissen höll inte), `generate_lease_contract`
 * (mätningen gav ett annat svar än beslutet) och `send_overdue_reminders`
 * (saknades i uppräkningen). Alla tre blev KRÄVER_MÄNNISKA.
 *
 * Skillnaden mellan 15 AUTOMATISK och 10 återupptagbara är inte en policyfråga:
 * fem poster faller på att spåret är `INGET`. De behöver en innehållsnyckel,
 * inte ett beslut — och det är nästa steg, inte det här.
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
 * POLICY, inte mekanik.
 *
 * ── PRINCIPEN SOM AVGÖR VÄRDET ──────────────────────────────────────────────
 *
 * Frågan är INTE "är det säkert att köra om" — den besvaras redan av
 * `effectIdempotency` och `traceDurability`, och den är mekanisk.
 *
 *     Frågan är: SKULLE EN DUBBLETT SYNAS FÖR EN MÄNNISKA UTANFÖR SYSTEMET?
 *
 * Syns den — ett brev, en signeringsinbjudan, ett krav, en post i
 * hyresgästportalen, en förändrad hyra — är svaret `KRÄVER_MÄNNISKA`, oavsett
 * hur säker mekaniken är. Stannar dubbletten inne i systemet, där en operatör
 * kan se och rätta den, får den vara `AUTOMATISK`.
 *
 * `mark_sent_to_collection` är provet på att principen inte är samma sak som
 * mekaniken: den är `IDEMPOTENT` och står ändå `KRÄVER_MÄNNISKA`, eftersom den
 * skriver en permanent DEBT_COLLECTION-post mot en enskild person.
 *
 * ── PRINCIPEN TILLÄMPAS PÅ ARTEFAKTEN, INTE PÅ NAMNET ───────────────────────
 *
 * Tre poster såg utåtriktade ut och är det inte. Mätt 2026-09-01:
 *
 *   • `create_invoice` skapar `status: 'DRAFT'`, och portalen döljer utkast
 *     (`getInvoices`: `status: { not: 'DRAFT' }`). Dubbletten syns bara för
 *     operatören.
 *   • `create_maintenance_ticket` sätter `propertyId` men INGEN `tenantId`, och
 *     `getMaintenanceTickets` filtrerar på `tenantId`. Ärendet hamnar aldrig i
 *     någons portal.
 *   • `update_maintenance_status` skriver sin kommentar med `isInternal: true`.
 *
 * Och en som såg intern ut och inte är det: `generate_lease_contract` sätter
 * `tenantId: lease.tenantId` på dokumentet, och `getDocuments` filtrerar bara
 * bort kategorin INVOICE — en andra kontrakts-PDF hamnar alltså i hyresgästens
 * dokumentlista.
 *
 * Slå upp vad verktyget FAKTISKT skriver och vem som kan läsa det. Namnet
 * räcker inte, och gissningen faller åt båda hållen.
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

/**
 * HUR PÅLITLIGT EFFEKTSPÅRET SKRIVS — `AiToolEffect`, inte idempotensnyckeln.
 *
 * ⚠️ TVÅ OLIKA SPÅR, OCH DE BLANDAS LÄTT IHOP. `traceDurability` ovan beskriver
 * var IDEMPOTENSENS spår bor (unikt index, statusmaskin, kö). Det här fältet
 * beskriver revisionsspåret `AiToolEffect` — svaret på "vad orsakade den här
 * körningen". De besvarar olika frågor och kan ha olika värden för samma
 * verktyg.
 *
 *  • `TRANSAKTIONELL` — spåret skrivs i SAMMA transaktion som effekten. Rullas
 *    effekten tillbaka försvinner spåret med den, och tvärtom. Får INTE sättas
 *    utan att `effect-trace-transactional.db.spec.ts` kan säga emot: den kör en
 *    transaktion som rullas tillbaka och kräver att spåret försvann.
 *  • `FÖRE_EFFEKTEN` — spåret skrivs och committas FÖRE effekten, och bär ett
 *    tillstånd som skiljer "påbörjad" från "utförd". Inte atomiskt, men aldrig
 *    tyst borta. (Formen #607 efterlyser för signeringen.)
 *  • `BÄST_MÖJLIGA` — spåret skrivs EFTER effekten, i en egen transaktion, utan
 *    att inväntas, och ett fel sväljs. Tre oberoende sätt att tappa det, inget
 *    av dem ger ett felmeddelande. Ett sådant spår kan inte besvara "blev det
 *    gjort?" — det kan bara bekräfta, aldrig dementera.
 *  • `OKÄND` — inte klassificerat. KASTAR vid bygget.
 *
 * ── MÄTT 2026-09-01: ALLA 30 STÅR BÄST_MÖJLIGA ──────────────────────────────
 *
 * Det är ingen försiktighet utan en mätning. `AiToolEffect` har EXAKT ETT
 * persisteringsställe (`ai/audit/ai-audit.service.ts`, nästlad `effects: {
 * create }` i `aiToolExecution.create`), och det nås av fyra anropare som alla
 * skriver `void this.audit.logToolExecution(...)`:
 *
 *     void                    processen kan dö innan löftet landar
 *     try/catch → logger.warn skrivningen kan falla och sväljas
 *     $extends ser inte tx    extensionen KAN inte gå med i anroparens
 *                             transaktion — dokumenterat i ai-effect-extension.ts
 *
 * Uppmätt negativkontroll samma dag: med persisteringen bortkopplad var HELA
 * sviten grön (338/338 sviter). Spåret var obevakat. Det är vad
 * `check-effect-trace.mjs` och `effect-trace-production-path.db.spec.ts` finns
 * för.
 */
export type TraceIntegrity = 'TRANSAKTIONELL' | 'FÖRE_EFFEKTEN' | 'BÄST_MÖJLIGA' | 'OKÄND'

export interface EffectDeclaration {
  effectIdempotency: EffectIdempotency
  idempotencyUnit: IdempotencyUnit
  traceDurability: TraceDurability
  /** Hur pålitligt `AiToolEffect` skrivs för det här verktyget. Se TraceIntegrity. */
  traceIntegrity: TraceIntegrity
  resumptionPolicy: ResumptionPolicy
  /**
   * Har policyn FATTATS, eller står värdet där konservativt i väntan på ett
   * beslut? `false` tvingar `KRÄVER_MÄNNISKA` — annars hade "ingen har tänkt på
   * det här än" sett ut som "en människa behövs", och de två är olika saker.
   *
   * Sätt `true` bara när principen ovan faktiskt prövats mot vad verktyget
   * skriver. Alla 30 poster är beslutade 2026-09-01; tre av dem stod på `false`
   * en runda — två därför att koden sa emot premissen, en därför att den aldrig
   * togs upp — och det är precis vad fältet är till för. Ett nytt verktyg börjar
   * på `false`.
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
    traceIntegrity: 'BÄST_MÖJLIGA',
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
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'AUTOMATISK',
    policyBeslutad: true,
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
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'AUTOMATISK',
    policyBeslutad: true,
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
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'AUTOMATISK',
    policyBeslutad: true,
    mekanismer: [{ typ: 'UNIKT_INDEX', modell: 'InvoicePayment', falt: ['bankTransactionId'] }],
  },

  // `if (transaction.status !== 'MATCHED') throw` — en omkörning mot en redan
  // hävd matchning avvisas.
  //
  // BESLUTAD KRÄVER_MÄNNISKA: premissen beslutet först vilade på höll inte. Den
  // är ingen intern bankflagga — `unmatchTransaction` reverserar betalningens
  // verifikat (`reverseJournalEntryForPayment`, atomiskt), RADERAR allokeringarna
  // (`invoicePayment.deleteMany`, `rentNoticePayment.deleteMany`), återställer
  // fakturans och avins status och skriver InvoiceEvent. Hyresgästens skuld
  // kommer tillbaka och kravtrappan kan starta om.
  unmatch_transaction: {
    effectIdempotency: 'IDEMPOTENT',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'DATABAS_TILLSTÅND', livslangd: DB_RAD },
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: true,
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
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'AUTOMATISK',
    policyBeslutad: true,
    mekanismer: [{ typ: 'UNIKT_INDEX', modell: 'Unit', falt: ['propertyId', 'unitNumber'] }],
  },

  // sourceId = ai:<innehållshash> + JournalEntry @@unique([organizationId,
  // source, sourceId]). Sedan #597 returnerar även ett SAMTIDIGT omförsök det
  // första verifikatet i stället för att kasta P2002.
  create_journal_entry: {
    effectIdempotency: 'IDEMPOTENT',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'DATABAS_HASH', livslangd: DB_RAD },
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'AUTOMATISK',
    policyBeslutad: true,
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
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'AUTOMATISK',
    policyBeslutad: true,
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
  //
  // ⚠️ KLASSNINGEN ÄR RIKTIG, MEN DÖLJER ETT FEL (#607). Dedup-raden skrivs FÖRE
  // providern anropas. Kraschar processen emellan får omförsöket P2002,
  // returnerar den befintliga raden och dispatchar ALDRIG — begäran blir
  // stående i PENDING medan anroparen får ett lyckat svar. En dubblett är
  // fortfarande omöjlig, så IDEMPOTENT stämmer; det är radens TILLSTÅND som är
  // tvetydigt mellan "påbörjad" och "utförd". Mätt i prod 2026-09-01: 0 sådana
  // rader av 0 SigningRequest totalt — latent, och nollan säger bara att vägen
  // aldrig körts skarpt. Fixen hör till G0, inte hit.
  prepare_contract_signing: {
    effectIdempotency: 'IDEMPOTENT',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'DATABAS_HASH', livslangd: DB_RAD },
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: true,
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
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'AUTOMATISK',
    policyBeslutad: true,
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
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'AUTOMATISK',
    policyBeslutad: true,
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
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'AUTOMATISK',
    policyBeslutad: true,
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
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: true,
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
    traceIntegrity: 'BÄST_MÖJLIGA',
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

  // Mekaniskt samma spärr som export_for_collection — OCH ändå KRÄVER_MÄNNISKA,
  // beslutat. Den skriver en permanent DEBT_COLLECTION-post mot en enskild
  // person. Mekaniken säger att det är säkert att köra om; det är inte samma
  // sak som att en maskin bör göra det.
  mark_sent_to_collection: {
    effectIdempotency: 'IDEMPOTENT',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'DATABAS_TILLSTÅND', livslangd: DB_RAD },
    traceIntegrity: 'BÄST_MÖJLIGA',
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
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: true,
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
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: true,
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
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: true,
    mekanismer: [],
  },

  // LOOP över förfallna fakturor, try/catch per mottagare, sent++. Ingen nyckel
  // alls skickas till mailService. Enheten MÅSTE bli EFFEKT.
  //
  // BESLUTAD KRÄVER_MÄNNISKA: den saknades i uppräkningen när policyn först
  // sattes (12 + 17 = 29 av 30) och stod därför en runda som obeslutad. Brev
  // till människor, i en loop, utan nyckel.
  send_overdue_reminders: {
    effectIdempotency: 'DEDUPLICERBAR',
    idempotencyUnit: 'EFFEKT',
    traceDurability: { plats: 'INGET', livslangd: 'inget spår finns' },
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: true,
    mekanismer: [],
  },

  // LOOP över hyresgäster. 15-min bulk-cooldown i Redis vid >5 mottagare är ett
  // trubbigt takt-skydd, inte idempotens: den blockerar ett LEGITIMT omförsök
  // och släpper igenom ett efter 15 minuter.
  compose_and_send_email: {
    effectIdempotency: 'DEDUPLICERBAR',
    idempotencyUnit: 'EFFEKT',
    traceDurability: { plats: 'INGET', livslangd: 'inget spår finns' },
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: true,
    mekanismer: [],
  },

  // PDF → R2 → Document.create. Document saknar unikt index; en omkörning ger
  // ett andra dokument. Document.contentHash finns redan och vore nyckeln.
  //
  // BESLUTAD KRÄVER_MÄNNISKA: mätningen gav ett annat svar än det första
  // beslutet, och mätningen vann. Verktyget sätter `tenantId: lease.tenantId`
  // och `category: 'CONTRACT'`, och portalens `getDocuments` filtrerar bara bort
  // kategorin INVOICE — en andra kontrakts-PDF hamnar i HYRESGÄSTENS
  // dokumentlista. Dubbletten är dessutom fullt möjlig, eftersom spåret är INGET.
  generate_lease_contract: {
    effectIdempotency: 'DEDUPLICERBAR',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'INGET', livslangd: 'inget spår finns' },
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: true,
    mekanismer: [],
  },

  // invoiceNumber allokeras ur en sekvens → varje omkörning får ett NYTT nummer
  // och blir en ny faktura. Sekvensnumret är motsatsen till en idempotensnyckel.
  create_invoice: {
    effectIdempotency: 'DEDUPLICERBAR',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'INGET', livslangd: 'inget spår finns' },
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'AUTOMATISK',
    policyBeslutad: true,
    mekanismer: [],
  },

  // contractNumber ur sekvens — samma sak som create_invoice.
  create_lease: {
    effectIdempotency: 'DEDUPLICERBAR',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'INGET', livslangd: 'inget spår finns' },
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: true,
    mekanismer: [],
  },

  // Skapar BÅDE hyresgäst och avtal. Sekvensnumret gäller avtalet; hyresgästen
  // har ingen unik nyckel på namn/e-post.
  create_tenant_and_lease: {
    effectIdempotency: 'DEDUPLICERBAR',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'INGET', livslangd: 'inget spår finns' },
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: true,
    mekanismer: [],
  },

  // Property saknar unikt index helt — inte ens namn eller beteckning.
  create_property: {
    effectIdempotency: 'DEDUPLICERBAR',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'INGET', livslangd: 'inget spår finns' },
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'AUTOMATISK',
    policyBeslutad: true,
    mekanismer: [],
  },

  // ticketNumber ur sekvens. ⚠️ Nämnaren är svår här: två identiska felanmälningar
  // på samma lägenhet samma dag KAN vara två verkliga fel. En innehållshash med
  // för grov nämnare gör tyst bortfall av det andra.
  create_maintenance_ticket: {
    effectIdempotency: 'DEDUPLICERBAR',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'INGET', livslangd: 'inget spår finns' },
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'AUTOMATISK',
    policyBeslutad: true,
    mekanismer: [],
  },

  // Inspection saknar unikt index.
  create_inspection: {
    effectIdempotency: 'DEDUPLICERBAR',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'INGET', livslangd: 'inget spår finns' },
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'AUTOMATISK',
    policyBeslutad: true,
    mekanismer: [],
  },

  // RentIncrease saknar unikt index. create() validerar bara 3-månadersbufferten
  // och att ny hyra > nuvarande — BÅDA passerar vid en omkörning, eftersom
  // lease-hyran inte skrivs om vid schemaläggningen. Två schemalagda höjningar.
  apply_rent_increase: {
    effectIdempotency: 'DEDUPLICERBAR',
    idempotencyUnit: 'ANROP',
    traceDurability: { plats: 'INGET', livslangd: 'inget spår finns' },
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: true,
    mekanismer: [],
  },

  // BLANDAD. Statusdelen är en ren update och idempotent; men addComment
  // APPENDAR, så en omkörning lägger kommentaren en andra gång. Den svagaste
  // halvan bestämmer klassen.
  update_maintenance_status: {
    effectIdempotency: 'DEDUPLICERBAR',
    idempotencyUnit: 'EFFEKT',
    traceDurability: { plats: 'INGET', livslangd: 'inget spår för kommentaren' },
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'AUTOMATISK',
    policyBeslutad: true,
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
    traceIntegrity: 'BÄST_MÖJLIGA',
    resumptionPolicy: 'KRÄVER_MÄNNISKA',
    policyBeslutad: true,
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
    // FAIL-CLOSED PÅ SPÅRETS INTEGRITET, av samma skäl som på klassificeringen.
    // `OKÄND` är inte ett tillstånd systemet får leva i: den som lägger till ett
    // verktyg ska ta ställning till hur dess spår skrivs, inte ärva en tyst
    // förmodan. Ett obesvarat fält blir annars ett påstående ingen gjort.
    if (d.traceIntegrity === 'OKÄND') {
      throw new Error(
        `Verktyget "${name}" har traceIntegrity: 'OKÄND'. Ta ställning till hur ` +
          `AiToolEffect skrivs för det — TRANSAKTIONELL, FÖRE_EFFEKTEN eller ` +
          `BÄST_MÖJLIGA. OKÄND betyder "ingen har svarat", och det får inte se ut ` +
          `som ett svar.`,
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

/**
 * Hur pålitligt effektspåret skrivs för ett verktyg.
 *
 * ⚠️ DEN HÄR KASTAR INTE på okänt namn, till skillnad från `isAutoResumable`.
 * Skillnaden är avsiktlig och beror på anroparen: det här är en VISNINGSVÄG
 * (`describeEffects` berättar för en människa vad en åtgärd orsakade). Ett kast
 * där hade bytt ut en ärlig icke-uppgift mot ett 500-fel — sämre för användaren
 * och sämre för sanningen.
 *
 * Den faller ändå stängt, fast i svarsledet: ett okänt verktyg ger `OKÄND`, och
 * `OKÄND` betyder "vi kan inte påstå något". Den svagaste utsagan, inte den
 * starkaste.
 */
export function effectTraceIntegrity(toolName: string): TraceIntegrity {
  return EFFECT_DECLARATIONS[toolName]?.traceIntegrity ?? 'OKÄND'
}

/**
 * Går det att lita på att en TOM effektlista betyder "verktyget skrev inget"?
 *
 * Bara om spåret skrivs så att det INTE kan tappas tyst. Med `BÄST_MÖJLIGA`
 * betyder en tom lista två saker — inget skrevs, eller spåret tappades — och
 * det är precis det en tom logg aldrig får göra (#586: en tom ErrorLog ska inte
 * kunna betyda två saker).
 */
export function tomEffektlistaÄrTrovärdig(toolName: string): boolean {
  const i = effectTraceIntegrity(toolName)
  return i === 'TRANSAKTIONELL' || i === 'FÖRE_EFFEKTEN'
}

/** Exponeras för vakten och specen som prövar att katalogen inte glider isär. */
export const EFFECT_DECLARATION_NAMES = Object.keys(EFFECT_DECLARATIONS)
