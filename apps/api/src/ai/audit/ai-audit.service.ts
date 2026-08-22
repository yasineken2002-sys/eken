// redact-copy-allow: #508:s maskering av AiToolExecution är en EGEN regel, inte en
// kopia. Den maskerar vid SKRIVNING och bredare (namn, e-post, mönster i fritext)
// eftersom audit-raden aldrig replayas till modellen — se docblocket nedan. Fält-
// listorna överlappar därför med redact-sensitive utan att vara samma sak.
import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../../common/prisma/prisma.service'
import { applyPatterns, AUDIT_PATTERNS, REPLACEMENT } from '../../common/redaction/patterns'
import type { AiToolEffect } from '../../common/ai-effects/ai-effects.context'

// Mönster för svenska personnummer (10 eller 12 siffror, valfri separator).
// Vi maskerar dessa innan de sparas i AiToolExecution.toolInput/toolResult
// så GDPR-loggen inte själv blir en personuppgiftsläcka.

/**
 * E-postadresser (#508). Maskeras som MÖNSTER och inte bara som fältnamn,
 * eftersom de förekommer på båda sätten: prod-mätningen 2026-08-19 fann sex
 * adresser fördelade på `toolResult[].tenant.email` (ett fält) och
 * `toolResult[].sentTo` (ett annat fältnamn för samma sorts värde). En
 * fältlista hade missat den andra halvan tills någon kom ihåg att lägga till
 * `sentTo`.
 */

/**
 * Svenska mobilnummer, MEDVETET SMALT.
 *
 * Dagens PNR-mönster fångar redan ett naket tiosiffrigt tal — `0701234567`
 * maskeras alltså i dag. Det som INTE fångas är de skrivsätt människor faktiskt
 * använder; uppmätt empiriskt, inte antaget:
 *
 *   "0701234567"       → maskeras redan (PNR-mönstret)
 *   "070-123 45 67"    → maskerades INTE
 *   "070-1234567"      → maskerades INTE
 *   "+46701234567"     → maskerades INTE
 *
 * FASTA TELEFONNUMMER INGÅR INTE, och det är ett val. Ett generellt
 * `0\d{1,3}[\s-]?\d{5,8}`-mönster hade träffat OCR-nummer och avtalsnummer
 * som ligger i samma loggar och som är själva spårbarheten. Prod-mätningen fann
 * NOLL telefonnummer av något slag, så breddningen är förebyggande — och då är
 * priset för ett falskt positivt högre än vinsten.
 */

/**
 * Maskera känsliga MÖNSTER i text: personnummer, organisationsnummer,
 * e-postadresser och mobilnummer.
 *
 * Anropas på alla strängar innan persistens i AiToolExecution.
 *
 * ── VARFÖR DEN HÄR VÄGEN FÅR SKÄRPAS NÄR ANDRA INTE FICK ────────────────────
 *
 * `AiMessage` och `AiMemory` matas tillbaka in i modellen — historiken replayas
 * och minnet går in i systemprompten — så maskering vid SKRIVNING där är ett
 * irreversibelt arbetsminnesbortfall, inte en rördragning. Det var skälet till
 * att #494 beslut 3a och 3b avslogs, och det står fast.
 *
 * `AiToolExecution` har ingen sådan väg: tabellen skrivs och gallras, och
 * ingenting läser tillbaka den till modellen eller till en vy i produkten.
 * Breddningen här kostar därför ingen funktion alls.
 */
export function maskSensitivePatterns(value: string): string {
  // Mönstren delas med visningsmaskeringen (#507) — se common/redaction/patterns.ts.
  // KOMPOSITIONEN är oförändrad: AUDIT_PATTERNS är exakt de fyra som stod här,
  // och breddas inte som sidoeffekt av ett annat ärende.
  return applyPatterns(value, AUDIT_PATTERNS)
}

/**
 * Rekursiv maskning av alla strängar i ett godtyckligt JSON-värde.
 * Tar även bort kända farliga fältnamn (passwordHash, activationToken etc.)
 * helt — de ska aldrig hamna i audit-loggen.
 */
const FORBIDDEN_FIELDS: ReadonlySet<string> = new Set([
  'passwordHash',
  'activationToken',
  'activationTokenExpiresAt',
  'sessionToken',
  'refreshToken',
  'magicLinkToken',
  'token',
  'apiKey',
])

const PERSONAL_NUMBER_FIELDS: ReadonlySet<string> = new Set([
  'personalNumber',
  'personalNumberEnc',
  'personalNumberHash',
])

/**
 * Fält som ALLTID maskeras oavsett innehåll (#508).
 *
 * Här ligger det som inte går att känna igen på formen. Ett personnummer har en
 * form; ett efternamn har det inte. Prod-mätningen 2026-08-19 fann namn i
 * `toolResult[].tenant.firstName` och `.lastName` — värden som inget
 * rimligt mönster kan träffa utan att också träffa allt annat.
 *
 * ── VAD SOM MEDVETET INTE STÅR HÄR ──────────────────────────────────────────
 *
 * `name` finns INTE med, och det är mätningens viktigaste enskilda utfall.
 * Samma mätning hittade `name` på två ställen — `toolResult[].lease.unit.name`
 * och `.lease.unit.property.name` — och inget av dem är en personuppgift. Det
 * är en lägenhetsbeteckning och ett fastighetsnamn, alltså precis det som gör
 * revisionsspåret läsbart: "AI:n skickade en påminnelse om lägenhet 1201 i
 * Ekhagen 3". Maskeras de blir loggen en rad maskeringar utan innehåll.
 *
 * Att `firstName`/`lastName` kan maskeras utan förlust beror på att raden bär
 * `tenantId` som egen kolumn. Identiteten finns kvar och är sökbar; det är
 * personuppgiften i fritexten som försvinner.
 *
 * Adressfälten ingår trots att prod-mätningen fann noll gatuadresser: en
 * hyresgästs adress är dennes bostad, och fälten är namngivna och därmed
 * träffsäkra att maska. Kostnaden för ett falskt positivt är noll här, till
 * skillnad från vid mönstermatchning.
 */
const PERSONAL_DATA_FIELDS: ReadonlySet<string> = new Set([
  'firstName',
  'lastName',
  'fullName',
  'contactName',
  'email',
  'emailAddress',
  'phone',
  'phoneNumber',
  'mobile',
  'mobilePhone',
  'address',
  'streetAddress',
  'careOf',
])

export function sanitizeForAudit<T>(value: T, depth = 0): T {
  if (depth > 12) return value
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    return maskSensitivePatterns(value) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeForAudit(v, depth + 1)) as unknown as T
  }
  if (typeof value === 'object' && !(value instanceof Date) && !(value instanceof Buffer)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_FIELDS.has(k)) continue
      // Personnummer-fälten på Tenant/Customer ersätts med REPLACEMENT så vi
      // vet att de fanns men inte vad de var. Blind-indexet räknas som känsligt
      // det med: det är deterministiskt och därmed en korrelerbar identifierare
      // för en fysisk person, även om det inte går att vända till ett personnr.
      if (PERSONAL_NUMBER_FIELDS.has(k)) {
        out[k] = REPLACEMENT
        continue
      }
      // #508: namn, e-post, telefon och adress maskeras på FÄLTNAMN. Ett
      // efternamn har ingen form att matcha på; identiteten bärs ändå av
      // radens egen `tenantId`-kolumn. Endast icke-tomma strängvärden ersätts,
      // så `null` fortsätter betyda "fanns inte" i stället för "fanns men är
      // dolt" — skillnaden är hela poängen med ett revisionsspår.
      if (PERSONAL_DATA_FIELDS.has(k)) {
        out[k] =
          typeof v === 'string' && v.length > 0 ? REPLACEMENT : sanitizeForAudit(v, depth + 1)
        continue
      }
      out[k] = sanitizeForAudit(v, depth + 1)
    }
    return out as unknown as T
  }
  return value
}

@Injectable()
export class AiAuditService {
  private readonly logger = new Logger(AiAuditService.name)

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Logga en tool-exekvering. Misslyckas tyst — vi vill aldrig att en
   * audit-logg-bugg ska blockera AI:n.
   */
  async logToolExecution(args: {
    /**
     * Radens id, förhandsallokerat av anroparen. Finns för att ett verifikat
     * som skapas INNE i verktyget ska kunna peka på den här raden — loggen
     * skrivs först efteråt, så id:t måste vara känt i förväg.
     *
     * Att skrivningen kan misslyckas tyst (se catch:en nedan) är exakt skälet
     * till att `JournalEntry.aiToolExecutionId` inte har någon främmande
     * nyckel: referensen får peka i tomma intet, faktumet bärs av
     * `source = AI`.
     */
    id?: string
    organizationId: string
    userId?: string | null
    tenantId?: string | null
    conversationId?: string | null
    toolName: string
    toolInput: Record<string, unknown>
    toolResult?: unknown
    success: boolean
    errorMessage?: string | null
    durationMs: number
    requiredConfirmation?: boolean
    confirmedAt?: Date | null
    /**
     * Vad körningen ORSAKADE. Samlas av Prisma-extensionen
     * (`common/prisma/ai-effect-extension.ts`) medan verktyget kör, aldrig av
     * verktyget självt — se ai-effects.context.ts för varför en konvention inte
     * hade hållit.
     */
    effects?: AiToolEffect[]
  }): Promise<void> {
    try {
      const sanitizedInput = sanitizeForAudit(args.toolInput)
      const sanitizedResult =
        args.toolResult !== undefined ? sanitizeForAudit(args.toolResult) : undefined

      await this.prisma.aiToolExecution.create({
        data: {
          ...(args.id !== undefined ? { id: args.id } : {}),
          organizationId: args.organizationId,
          userId: args.userId ?? null,
          tenantId: args.tenantId ?? null,
          conversationId: args.conversationId ?? null,
          toolName: args.toolName,
          toolInput: sanitizedInput as object,
          ...(sanitizedResult !== undefined ? { toolResult: sanitizedResult as object } : {}),
          success: args.success,
          errorMessage: args.errorMessage ?? null,
          durationMs: args.durationMs,
          requiredConfirmation: args.requiredConfirmation ?? false,
          confirmedAt: args.confirmedAt ?? null,
          // NÄSTLAD SKRIVNING, inte en andra `create`. Effekterna hör till
          // auditraden och ska dela dess öde: blir raden inte skriven ska
          // effekterna inte heller finnas, för de pekar då på ett
          // `aiToolExecutionId` som ingen kan slå upp.
          ...(args.effects && args.effects.length > 0
            ? {
                effects: {
                  create: args.effects.map((e) => ({
                    organizationId: args.organizationId,
                    entityType: e.entityType,
                    entityId: e.entityId,
                    operation: e.operation,
                    rowCount: e.rowCount,
                  })),
                },
              }
            : {}),
        },
      })
    } catch (err) {
      this.logger.warn(
        `Kunde inte spara AiToolExecution för ${args.toolName}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}
