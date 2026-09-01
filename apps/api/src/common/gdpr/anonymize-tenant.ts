import type { Prisma } from '@prisma/client'

/**
 * AVIDENTIFIERING AV EN HYRESGÄST — GDPR Art. 17, en enda implementation.
 *
 * ── VARFÖR AVIDENTIFIERING OCH INTE RADERING ────────────────────────────────
 *
 * Två skäl, och det första är rent mekaniskt:
 *
 *   1. En hyresgäst med historik GÅR INTE att radera. Elva modeller bär
 *      Restrict-FK mot `Tenant` (Lease, Invoice, Document ×2, MaintenanceTicket,
 *      RentNotice, Inspection, SentMessage, Deposit, KeyHandover,
 *      ConsumptionCharge, MiscCharge). Mätt i dev: 5 av 532 hyresgäster (0,9 %)
 *      är faktiskt raderbara — de som aldrig haft ett avtal.
 *   2. Underlaget SKA bevaras. Avierna och verifikaten är räkenskapsmaterial.
 *
 * Avidentifiering är därför den enda operation som faktiskt kan verkställa en
 * raderingsbegäran mot en verklig hyresgäst.
 *
 * ── VARFÖR EN DELAD FUNKTION ────────────────────────────────────────────────
 *
 * Det finns två vägar hit: hyresgästen själv via portalen, och operatören via
 * webbappen. De ska ge IDENTISKT sluttillstånd. Två kopior av fältlistan
 * divergerar första gången någon lägger till en kolumn — och den divergensen
 * syns inte i något test som bara kör en av vägarna. Samma skäl som
 * `assertPaymentWithinDebt` finns i ett exemplar.
 *
 * ── IDEMPOTENS ──────────────────────────────────────────────────────────────
 *
 * Funktionen är idempotent BY CONSTRUCTION: att nolla ett redan nollat fält är
 * en no-op. Den körs därför om även på en redan avidentifierad hyresgäst, så att
 * data som tillkommit efteråt (t.ex. en ny nyckelkvittens) också skrubbas.
 *
 * Två saker rörs däremot INTE en andra gång:
 *   - `anonymizedAt` behåller sin FÖRSTA tidpunkt. Den svarar på "när begärdes
 *     radering", inte "när kördes skrubben senast".
 *   - Ingen ny loggrad skrivs. En idempotent operation ska inte se ut som
 *     upprepade raderingsbegäranden i revisionsspåret.
 *
 * Returvärdet säger vilket av fallen som inträffade, så att anroparen kan skilja
 * "verkställde nu" från "var redan verkställd" utan att gissa.
 */
export interface AnonymizeResult {
  /** false = hyresgästen var redan avidentifierad; ingen ny loggrad skrevs. */
  performed: boolean
  /** Tidpunkten för den FÖRSTA avidentifieringen. */
  anonymizedAt: Date
}

export interface AnonymizeActor {
  /** null = hyresgästen själv via portalen (ingen User finns att peka på). */
  performedById: string | null
  ipAddress?: string | undefined
  userAgent?: string | undefined
  reason?: string | undefined
}

export function maskedTenantEmail(tenantId: string): string {
  return `gdpr-deleted-${tenantId.slice(0, 8)}@gdpr.invalid`
}

/**
 * ── AI-LAGRET: RIKTAD SKRUBBNING DÄR `tenantId` FINNS ───────────────────────
 *
 * KASKADEN ÄR INTE SVARET, OCH DET ÄR HELA POÄNGEN MED DEN HÄR LISTAN.
 *
 * Tre AI-tabeller bär `tenantId` och deklarerar en FK mot `Tenant`:
 * `AiTenantConversation` (Cascade), `AiToolExecution` och `AiUsageLog`
 * (båda SetNull). Det SER ut som att databasen sköter städningen åt oss.
 *
 * Den gör den inte. `onDelete` fyrar bara när en `Tenant`-RAD RADERAS, och
 * avidentifiering raderar aldrig — den gör `tenant.update()` och maskerar
 * fälten i stället (se skälen överst i filen: elva Restrict-FK gör radering
 * omöjlig för en hyresgäst med historik). Raden finns kvar efteråt, alltså
 * fyrar varken kaskaden eller SetNull, alltså låg hyresgästens egen
 * AI-chatthistorik kvar i klartext efter en verkställd raderingsbegäran.
 *
 * Därför agerar den här funktionen EXPLICIT. Vakten i specen bredvid härleder
 * ur `schema.prisma` vilka `Ai*`-modeller som bär `tenantId` och kräver att var
 * och en står nedan — och den räknar UTTRYCKLIGEN INTE en kaskad som täckning,
 * just för att den defekten inte ska kunna återuppstå.
 *
 * Listan driver också körningen (samma mönster som `DELETION_STEPS` i
 * `delete-organization.ts`), så vad vakten kontrollerar och vad koden gör kan
 * inte glida isär.
 */
export type AiTenantLinkAction = 'delete' | 'unlink' | 'keep'

export interface AiTenantLinkStep {
  /** Prisma-modellnamn, exakt som i schema.prisma. */
  model: string
  action: AiTenantLinkAction
  /** Varför just den här åtgärden. Läses av människor, inte av kod. */
  reason: string
}

export const AI_TENANT_LINK_STEPS: readonly AiTenantLinkStep[] = [
  {
    model: 'AiTenantConversation',
    action: 'delete',
    reason:
      'Hyresgästens EGEN chatt med AI:n. Hela raden är den hyresgästens data — ' +
      'det finns inget granularitetsproblem här, till skillnad från operatörens ' +
      '`AiMessage` där ett svar kan handla om flera hyresgäster samtidigt. Inget ' +
      'bevarandeskäl: det är varken räkenskapsmaterial eller revisionsspår över ' +
      'hyresvärdens handlingar. `AiTenantMessage` faller med via sin egen ' +
      'Cascade mot konversationen — den kaskaden FYRAR, eftersom vi faktiskt ' +
      'raderar konversationsraden.',
  },
  {
    model: 'AiToolExecution',
    action: 'unlink',
    reason:
      'Raden är ett revisionsspår och rörs INTE. Om den är räkenskapsinformation ' +
      'är en öppen fråga för verksam revisor (#505), och att förstöra underlaget ' +
      'medan frågan är obesvarad är inte vårt beslut att fatta. Kopplingen nollas ' +
      'däremot: `tenantId` är AKTÖREN (hyresgästen som chattade via portalen), ' +
      'inte ämnet, och det är just den kopplingen mellan person och logg som en ' +
      'raderingsbegäran träffar. Fritexten i `toolInput`/`toolResult` är en egen ' +
      'fråga (#508) och rörs inte här. `SetNull` i schemat säger redan att detta ' +
      'är rätt sluttillstånd — vi ser till att det faktiskt inträffar.',
  },
  {
    model: 'AiUsageLog',
    action: 'unlink',
    reason:
      'Raden bär INGEN fritext alls — bara tokens, kostnad och tidpunkt — så det ' +
      'finns ingenting att skrubba i innehållet. Den måste dessutom bevaras: ' +
      'org-kvot och månadsfakturering läser den, och FK:n mot Organization är ' +
      'Restrict. Kopplingen nollas. Uppmätt att det är ofarligt: all ' +
      'org-aggregering nycklar på `organizationId` (ai-usage.service.ts), aldrig ' +
      'på `tenantId`. Det enda som slutar fungera är `getTenantUsage(tenantId)` ' +
      'för just den hyresgästen — vilket är önskat utfall, inte en regression.',
  },
  {
    model: 'AiMessageTenant',
    action: 'keep',
    reason:
      'ÄMNESKOPPLINGEN (#510) RÖRS INTE — och det är ett aktivt beslut, inte ett ' +
      'förbiseende. Att radera kopplingen vid avidentifiering hade gjort läget ' +
      'SÄMRE, inte bättre: innehållet i `AiMessage` ligger kvar oavsett (det är ' +
      'den öppna frågan i #494), medan förmågan att HITTA raderna hade försvunnit ' +
      'i exakt det ögonblick den behövs. Kopplingen bär dessutom inga ' +
      'identifierande uppgifter i sig — den är ett par av två UUID:n, och raden ' +
      'den pekar på är just avidentifierad. Den som senare bygger verkställandet ' +
      'behöver den här kopplingen; den ska finnas kvar då.',
  },
  {
    model: 'AiMemoryTenant',
    action: 'keep',
    reason:
      'Samma skäl som `AiMessageTenant` ovan. Här väger det tyngre: ett minne ' +
      'handlar nästan alltid om EN hyresgäst, så det är den kopplingen som gör en ' +
      'riktad radering av `AiMemory` möjlig över huvud taget. Raderas den finns ' +
      'bara textsökning kvar — vägen som avfärdades i #494.',
  },
]

type AiDelegate = {
  deleteMany: (a: unknown) => Promise<{ count: number }>
  updateMany: (a: unknown) => Promise<{ count: number }>
}

/** Modellnamn → Prisma-klientens egenskap (`AiUsageLog` → `aiUsageLog`). */
export const aiClientKey = (model: string): string => model.charAt(0).toLowerCase() + model.slice(1)

const aiDelegate = (tx: Prisma.TransactionClient, model: string): AiDelegate => {
  const d = (tx as unknown as Record<string, AiDelegate | undefined>)[aiClientKey(model)]
  // Ett stegnamn utan motsvarande modell ska smälla här, inte tyst hoppas över.
  // Vakten fångar det i test; det här fångar det i körning.
  if (!d) throw new Error(`Okänd modell i AI-skrubbningen: ${model}`)
  return d
}

/**
 * Kör AI-lagrets riktade skrubbning. Exporterad för att kunna köras och
 * verifieras separat; anropas av `anonymizeTenantWithin`.
 *
 * Idempotent: `deleteMany` på en redan tömd mängd och `updateMany` som sätter
 * `tenantId = null` där `tenantId` redan är null matchar båda noll rader.
 */
export async function scrubAiTenantLinks(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<Record<string, number>> {
  const touched: Record<string, number> = {}
  for (const step of AI_TENANT_LINK_STEPS) {
    // `keep` rör medvetet ingenting. Steget finns för att beslutet ska vara
    // SKRIVET och kontrollerbart av vakten — inte för att raden råkar bli kvar
    // om ingen tänkte på den. Det var precis den skillnaden som gjorde att
    // hyresgästens egen chatt låg orörd i månader.
    if (step.action === 'keep') {
      touched[step.model] = 0
      continue
    }
    const d = aiDelegate(tx, step.model)
    const { count } =
      step.action === 'delete'
        ? await d.deleteMany({ where: { tenantId } })
        : await d.updateMany({ where: { tenantId }, data: { tenantId: null } })
    touched[step.model] = count
  }
  return touched
}

/**
 * ── ErrorLog: RADERA, INTE MASKERA (#612) ───────────────────────────────────
 *
 * `ErrorLog.message` och `.stack` är OSTRUKTURERAD fritext från kastade fel.
 * Mätt i #612 mot dev-databasen: ett `PrismaClientValidationError` skriver ut
 * hela argumentobjektet — `email`, `personalNumber`, `phone`, `street`
 * ordagrant — och ett Postgres-constraintfel bär `Failing row contains (…)`
 * med varje kolumnvärde i raden.
 *
 * EN FRITEXTKOLUMN GÅR INTE ATT ANONYMISERA, BARA ATT RADERA. Det är hela
 * skälet till att det här steget tar bort rader i stället för att nolla fält,
 * och det är en annan avvägning än resten av filen gör:
 *
 *   • Att maskera kända fält (som `tenant.update()` ovan gör) förutsätter att
 *     man VET vilka fält som bär personuppgiften. I fritext vet man det inte.
 *   • Att söka-och-ersätta namn/e-post i texten hade blivit en heuristik som
 *     ibland missar (avstavning, escaping, en Prisma-dump med citattecken) och
 *     ibland träffar fel rad. En avidentifiering som "ibland" fungerar är inte
 *     en avidentifiering.
 *   • Raden har inget bevarandeskäl som väger emot. Den är ett DRIFTVERKTYG
 *     (beslutat i #612, se `schema.prisma` och `error-log-retention.ts`), inte
 *     räkenskapsmaterial och inte ett revisionsspår över hyresvärdens
 *     handlingar. Jämför `SentMessage` nedan, som INTE skrubbas just för att
 *     den kan ha en bevisfunktion.
 *
 * ── VARFÖR MATCHNINGEN ÄR PÅ FORMEN, INTE PÅ EN NYCKELLISTA ─────────────────
 *
 * Frågan matchar hyresgästens UUID var som helst i `message`, `stack` eller den
 * serialiserade `context`. Alternativet — att räkna upp de kontextnycklar som
 * i dag bär ett tenant-id (`context.tenantId` skrivs från
 * `tenant-auth.service.ts`, och id:t kan stå i `context.path` för en 500 på
 * `/v1/tenants/<id>`) — är en UPPRÄKNING som slutar stämma första gången någon
 * lägger till en ny `detail: { … }`. Den nya nyckeln hade då inte fällt något
 * test; raden hade bara tyst blivit kvar. Matcha formen, inte listan.
 *
 * Falska träffar är i praktiken uteslutna: nålen är en full UUID.
 *
 * ── VAD STEGET INTE KAN NÅ, UTSKRIVET ───────────────────────────────────────
 *
 * En rad som nämner hyresgästen ENBART med namn, e-post eller personnummer och
 * aldrig med sitt UUID träffas inte. Att fånga den hade krävt textmatchning på
 * identifierarna, som måste läsas FÖRE `tenant.update()` (se kommentaren vid
 * AI-blocket nedan) och som bär just de träffsäkerhetsproblem som avfärdas
 * ovan. För den resten är svaret FRISTEN i `error-log-retention.ts` — 30 dagar
 * löst, 180 olöst — inte den här funktionen. De två mekanismerna täcker olika
 * saker: den här är personen, fristen är tiden.
 *
 * ── INGEN ORG-AVGRÄNSNING, MED FLIT ─────────────────────────────────────────
 *
 * Frågan filtrerar inte på `organizationId`. En ErrorLog-rad kan ha
 * `organizationId = null` (HTTP-fel före inloggning, frontend-rapporter) och
 * ändå bära hyresgästens id. Hade vi avgränsat på org hade just de raderna
 * överlevt raderingsbegäran. UUID:t ÄR avgränsningen.
 */
export async function purgeTenantErrorLogRows(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<number> {
  // Parametriserad — `tenantId` binds, den interpoleras inte in i SQL:en.
  return tx.$executeRaw`
    DELETE FROM "ErrorLog"
    WHERE position(${tenantId} in "message") > 0
       OR position(${tenantId} in coalesce("stack", '')) > 0
       OR position(${tenantId} in "context"::text) > 0
  `
}

/**
 * Kör avidentifieringen inuti en befintlig transaktion.
 *
 * Anroparen äger transaktionen, eftersom operatörsvägen behöver läsa grindar i
 * samma transaktion som den skriver.
 */
export async function anonymizeTenantWithin(
  tx: Prisma.TransactionClient,
  tenantId: string,
  organizationId: string,
  actor: AnonymizeActor,
): Promise<AnonymizeResult> {
  const before = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { anonymizedAt: true },
  })
  const alreadyDone = before.anonymizedAt !== null
  const now = new Date()

  await tx.tenant.update({
    where: { id: tenantId },
    data: {
      firstName: null,
      lastName: null,
      companyName: 'Raderad hyresgäst',
      email: maskedTenantEmail(tenantId),
      phone: null,
      // Radera personnumret i BÅDA kolumnerna: chiffertext och blind-index.
      // Missas blind-indexet går personen fortfarande att korrelera efter en
      // Art. 17-radering — hashen är deterministisk och jämförbar mellan rader.
      personalNumberEnc: null,
      personalNumberHash: null,
      orgNumber: null,
      street: null,
      city: null,
      postalCode: null,
      contactPerson: null,
      passwordHash: null,
      portalActivated: false,
      activationTokenHash: null,
      activationTokenExpiresAt: null,
      activationReminderSentAt: null,
      passwordResetTokenHash: null,
      passwordResetTokenExpiresAt: null,
      // Behåll den första tidpunkten vid en upprepad körning.
      ...(alreadyDone ? {} : { anonymizedAt: now }),
    },
  })

  // Aktiva sessioner faller omedelbart, utan att vänta på att en token går ut.
  // Samma grepp som UsersService.deactivate återkallar refresh-tokens.
  await tx.tenantSession.deleteMany({ where: { tenantId } })

  // ── FRITEXTNAMN I ANGRÄNSANDE TABELL ──────────────────────────────────────
  //
  // `KeyHandover.issuedToName` bär namnet på den som fysiskt kvitterade nyckeln
  // när det var någon annan än hyresgästen (sambo, firmatecknare). Det är ett
  // rent namnfält utan rättslig funktion — kvittensen bevisas av raden själv,
  // inte av namnsträngen — och nollas därför.
  await tx.keyHandover.updateMany({
    where: { tenantId, issuedToName: { not: null } },
    data: { issuedToName: null },
  })

  // ── UTTRYCKLIGT UNDANTAG: SentMessage ─────────────────────────────────────
  //
  // `SentMessage.subject` och `.content` kan bära namn och personnummer, och
  // skrubbas ändå INTE här. Det är ett medvetet undantag, inte ett förbiseende.
  //
  // Skälet är att ett skickat meddelande kan VARA ett hyresrättsligt dokument —
  // en hyreshöjning, en rättelseanmaning, en uppsägning — där brödtexten är
  // beviset för vad som faktiskt meddelats och när. Att skrubba den kan förstöra
  // hyresvärdens möjlighet att göra en rättighet gällande.
  //
  // Avvägningen mellan den bevisfunktionen och Art. 17 är en HYRESRÄTTSLIG fråga
  // som ligger öppen för mänsklig juridisk bedömning. Inget lagrum skrivs här
  // förrän den är avgjord. Se GDPR-ärendet.
  //
  // Lägg alltså inte till en `sentMessage.updateMany` här utan att först läsa
  // det svaret.

  // ── AI-LAGRET ─────────────────────────────────────────────────────────────
  //
  // ORDNINGEN SPELAR INGEN ROLL HÄR — OCH DET ÄR INGEN SLUMP.
  //
  // Blocket står EFTER `tenant.update()` ovan, som just har maskerat namn,
  // e-post och adress. Det går bra därför att varje steg nedan matchar på
  // `tenantId` — en primärnyckelreferens som `update` aldrig rör. Nålen finns
  // alltså kvar oförändrad hela vägen igenom funktionen.
  //
  // FLYTTA INTE HIT NÅGOT SOM MATCHAR PÅ TEXT. En framtida skrubbning som söker
  // efter namn/adress/e-post i fritext (`AiMessage`, `AiMemory` — beslut D i
  // GDPR-ärendet, inte byggd) har INTE den egenskapen: efter `update` är fälten
  // nollade och det finns ingenting kvar att söka med. En sådan skrubbning måste
  // läsa identifierarna FÖRE `update` och köras före det. Att den här listan
  // ligger efter är alltså ett bevis på att den är id-baserad, inte ett
  // godtyckligt val som nästa steg kan ärva.
  //
  // Körs även när `alreadyDone` är true: funktionen är idempotent och ska fånga
  // AI-data som tillkommit efter den första körningen.
  await scrubAiTenantLinks(tx, tenantId)

  // ── FELLOGGEN ─────────────────────────────────────────────────────────────
  //
  // Ligger här av samma skäl som AI-blocket ovan: steget är ID-BASERAT och
  // matchar på hyresgästens UUID, som `tenant.update()` aldrig rör. Nålen finns
  // alltså kvar oförändrad. Se docblocket vid `purgeTenantErrorLogRows` för
  // varför raderna raderas i stället för att maskeras.
  //
  // Körs även när `alreadyDone` är true: en ny felrad kan ha skrivits efter den
  // första körningen, och funktionen ska vara idempotent i sluttillstånd — inte
  // bara i sin första körning.
  await purgeTenantErrorLogRows(tx, tenantId)

  if (!alreadyDone) {
    await tx.tenantAnonymizationLog.create({
      data: {
        organizationId,
        tenantId,
        performedById: actor.performedById,
        performedAt: now,
        ...(actor.ipAddress ? { ipAddress: actor.ipAddress } : {}),
        ...(actor.userAgent ? { userAgent: actor.userAgent } : {}),
        ...(actor.reason ? { reason: actor.reason } : {}),
      },
    })
  }

  return { performed: !alreadyDone, anonymizedAt: before.anonymizedAt ?? now }
}
