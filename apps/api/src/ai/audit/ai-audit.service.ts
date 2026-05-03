import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../../common/prisma/prisma.service'

// Mönster för svenska personnummer (10 eller 12 siffror, valfri separator).
// Vi maskerar dessa innan de sparas i AiToolExecution.toolInput/toolResult
// så GDPR-loggen inte själv blir en personuppgiftsläcka.
const SWEDISH_PNR = /\b(?:\d{2})?\d{6}[-+]?\d{4}\b/g
const SWEDISH_ORGNR = /\b\d{6}-\d{4}\b/g

const REPLACEMENT = '***MASKERAT***'

/**
 * Maskera personnummer- och organisationsnummer-mönster i text.
 * Anropas på alla strängar innan persistens i AiToolExecution.
 */
export function maskSensitivePatterns(value: string): string {
  return value.replace(SWEDISH_PNR, REPLACEMENT).replace(SWEDISH_ORGNR, REPLACEMENT)
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
      // Personnummer-fältet på Tenant ersätts med REPLACEMENT så vi vet
      // att det fanns men inte vad det var.
      if (k === 'personalNumber') {
        out[k] = REPLACEMENT
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
    organizationId: string
    userId: string
    conversationId?: string | null
    toolName: string
    toolInput: Record<string, unknown>
    toolResult?: unknown
    success: boolean
    errorMessage?: string | null
    durationMs: number
    requiredConfirmation?: boolean
    confirmedAt?: Date | null
  }): Promise<void> {
    try {
      const sanitizedInput = sanitizeForAudit(args.toolInput)
      const sanitizedResult =
        args.toolResult !== undefined ? sanitizeForAudit(args.toolResult) : undefined

      await this.prisma.aiToolExecution.create({
        data: {
          organizationId: args.organizationId,
          userId: args.userId,
          conversationId: args.conversationId ?? null,
          toolName: args.toolName,
          toolInput: sanitizedInput as object,
          ...(sanitizedResult !== undefined ? { toolResult: sanitizedResult as object } : {}),
          success: args.success,
          errorMessage: args.errorMessage ?? null,
          durationMs: args.durationMs,
          requiredConfirmation: args.requiredConfirmation ?? false,
          confirmedAt: args.confirmedAt ?? null,
        },
      })
    } catch (err) {
      this.logger.warn(
        `Kunde inte spara AiToolExecution för ${args.toolName}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}
