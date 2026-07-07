import { Inject, Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'
import { ReconciliationService } from '../reconciliation/reconciliation.service'
import { BankConsentCryptoService } from './bank-consent-crypto.service'
import { PSD2_PROVIDER, type BankDataProvider, type ProviderRawTx } from './psd2.types'

export interface Psd2SyncResult {
  organizationId: string
  consents: number
  fetched: number
  imported: number
  duplicates: number
  rejected: number
  matched: number
}

/**
 * PSD2-synk för EN org. Hämtar råa transaktioner via bank-API-porten och matar
 * dem genom den härdade ReconciliationService.ingestFromApi (samma pipeline som
 * filimporten). Rör ALDRIG AccountingService/journal-repos direkt — den enda
 * vägen till bokföringen går via ingestFromApi (DI-spärr: modulen injicerar inte
 * AccountingService).
 *
 * organizationId kommer från jobbet (härlett ur VÅR BankConsent), aldrig ur
 * aggregatorns råsvar. Varje synk skriver en BankStatementImport-post (fileType
 * 'api') för BFL-audit-paritet med fil-importerna.
 */
@Injectable()
export class Psd2SyncService {
  private readonly logger = new Logger(Psd2SyncService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciliation: ReconciliationService,
    private readonly crypto: BankConsentCryptoService,
    @Inject(PSD2_PROVIDER) private readonly provider: BankDataProvider,
  ) {}

  private toApiRaw(tx: ProviderRawTx) {
    return {
      bookingDate: tx.bookingDate,
      booked: tx.booked,
      currency: tx.currency,
      amount: tx.amount,
      description: tx.description,
      ...(tx.ocr ? { ocr: tx.ocr } : {}),
      ...(tx.reference ? { reference: tx.reference } : {}),
    }
  }

  async syncOrganization(organizationId: string): Promise<Psd2SyncResult> {
    const result: Psd2SyncResult = {
      organizationId,
      consents: 0,
      fetched: 0,
      imported: 0,
      duplicates: 0,
      rejected: 0,
      matched: 0,
    }

    const consents = await this.prisma.bankConsent.findMany({
      where: { organizationId, status: 'ACTIVE' },
    })
    result.consents = consents.length

    for (const consent of consents) {
      const accessToken = this.crypto.decrypt(consent.accessTokenEnc)

      // Consent-livscykel: gått ut/återkallats hos banken → pausa (påverkar bara
      // INFLÖDET, aldrig bokföringen). Nästa lyckade samtycke återupptar synken.
      const statusCheck = await this.provider.getConsentStatus({
        consentId: consent.consentId,
        accessToken,
      })
      if (statusCheck.status !== 'ACTIVE') {
        // Dataminimering: ett dött samtycke ska inte bära kvar bank-tokens.
        await this.prisma.bankConsent.update({
          where: { id: consent.id },
          data: {
            status: statusCheck.status === 'REVOKED' ? 'REVOKED' : 'EXPIRED',
            accessTokenEnc: '',
            refreshTokenEnc: null,
          },
        })
        this.logger.warn(
          `[psd2] samtycke ${consent.id} inte längre aktivt (${statusCheck.status}) — synk pausad`,
        )
        continue
      }

      const accounts = await this.provider.listAccounts({
        consentId: consent.consentId,
        accessToken,
      })

      let latestCursor = consent.syncCursor ?? undefined
      const rawTxs: ProviderRawTx[] = []
      for (const account of accounts) {
        const page = await this.provider.fetchTransactions({
          consentId: consent.consentId,
          accessToken,
          accountId: account.accountId,
          since: consent.syncCursor ?? undefined,
        })
        rawTxs.push(...page.transactions)
        if (page.cursor) latestCursor = page.cursor
      }
      result.fetched += rawTxs.length

      for (const tx of rawTxs) {
        // Den härdade vägen in. externalId = bankens id (idempotent). booked-only,
        // valuta, storno/negativa och cross-source-dedup hanteras EXPLICIT i
        // ingestFromApi — inget tyst bortfall.
        const outcome = await this.reconciliation.ingestFromApi(
          organizationId,
          tx.externalId,
          this.toApiRaw(tx),
        )
        if (outcome.outcome === 'imported') {
          result.imported++
          if (outcome.matched) result.matched++
        } else if (outcome.outcome === 'duplicate') {
          result.duplicates++
        } else {
          result.rejected++
        }
      }

      await this.prisma.bankConsent.update({
        where: { id: consent.id },
        data: { lastSyncedAt: new Date(), ...(latestCursor ? { syncCursor: latestCursor } : {}) },
      })
    }

    // BFL-audit-paritet: varje synk lämnar ett spår, precis som fil-importerna.
    await this.prisma.bankStatementImport.create({
      data: {
        organizationId,
        fileName: `PSD2-synk ${new Date().toISOString()}`,
        fileType: 'api',
        fileSize: 0,
        status: 'CONFIRMED',
        transactionCount: result.imported,
        matchedCount: result.matched,
        unmatchedCount: result.imported - result.matched,
      },
    })

    this.logger.log(
      `[psd2] synk klar org=${organizationId}: fetched=${result.fetched} imported=${result.imported} dup=${result.duplicates} rejected=${result.rejected} matched=${result.matched}`,
    )
    return result
  }
}
