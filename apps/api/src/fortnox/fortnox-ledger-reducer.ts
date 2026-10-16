import type { LedgerReadConfig, LedgerReadResult, LedgerRowProvenance } from './fortnox-ledger'
import { Incomplete, type ValidatedLedgerVoucher } from './fortnox-ledger-validation'

const LIMITATION =
  'Läsningen är en genomgång sida för sida, inte en låst ögonblicksbild: ändringar under läsningen och raderingar upptäcks inte alltid.'

function addOre(left: number, right: number): number {
  const sum = left + right
  if (!Number.isSafeInteger(sum))
    throw new Incomplete('Beloppssumman ligger utanför säkert talområde')
  return sum
}

type LedgerBase = Pick<
  LedgerReadResult,
  'coverage' | 'uncertainties' | 'references' | 'financialYear'
>

/**
 * Befintlig summering uppdelad per validerat verifikat. Anroparen ansvarar för
 * unika identiteter och samma lexikografiska ordning som readLedger använder.
 * Ett finish-resultat får publiceras först när hela manifestet är verifierat.
 * Detta är ingen beständig checkpoint eller ny ekonomisk beräkningsmodell.
 *
 * add uppdaterar basens referenser/varningar som tidigare: vid overflow kan
 * readLedger återge exakt det prefix som hunnit observeras, med summary/rows=null.
 */
export function createLedgerAccumulator(
  cfg: LedgerReadConfig,
  base: LedgerBase,
): { add(voucher: ValidatedLedgerVoucher): void; finish(): LedgerReadResult } {
  const accounts = new Set(cfg.costAccounts)
  const rows: LedgerRowProvenance[] = []
  const byProperty = new Map<
    string,
    { propertyId: string; propertyName: string; amountOre: number }
  >()
  const unmapped = new Map<
    string,
    { dimensionType: 'COST_CENTER' | 'PROJECT'; code: string; amountOre: number }
  >()
  let total = 0
  let unallocated = 0
  let removed = 0
  let eveno = 0
  let uncertain = false
  let failure: { error: unknown } | null = null

  return {
    add(voucher) {
      if (failure) throw failure.error
      try {
        const { key, date } = voucher
        if (date < cfg.periodFrom || date > cfg.periodTo) return
        const evenoExport = cfg.evenoExported.has(key)
        if (voucher.reference) {
          base.references.push({
            voucher: key,
            referenceType: voucher.reference.type,
            referenceNumber: voucher.reference.number,
          })
        }
        for (const row of voucher.rows) {
          if (!accounts.has(row.account)) continue
          const amountOre = row.debitOre - row.creditOre
          const cc = row.costCenter
          const pr = row.project
          const dimensionType = cc ? 'COST_CENTER' : pr ? 'PROJECT' : null
          const code = cc ?? pr
          const provenance: LedgerRowProvenance = {
            voucher: key,
            row: row.index1,
            transactionDate: date,
            account: row.account,
            amountOre,
            bucket: 'UNALLOCATED',
            dimensionType,
            code,
            propertyId: null,
            evenoExport,
          }
          if (row.removed) {
            provenance.bucket = 'UNCERTAIN_REMOVED'
            removed = addOre(removed, amountOre)
            uncertain = true
            base.uncertainties.push(
              `Verifikat ${key} rad ${row.index1} är markerad som borttagen i Fortnox; innebörden är inte belagd och raden ingår inte i summan.`,
            )
            rows.push(provenance)
            continue
          }
          total = addOre(total, amountOre)
          if (evenoExport) eveno = addOre(eveno, amountOre)
          if (!dimensionType && voucher.headerDimensionPresent) {
            uncertain = true
            base.uncertainties.push(
              `Verifikat ${key}: dimension finns bara på verifikatets huvud och har inte förts över till raden.`,
            )
          }
          if (dimensionType && code) {
            const mapping = cfg.mappings.get(`${dimensionType}:${code}`)
            if (mapping) {
              provenance.bucket = 'PROPERTY'
              provenance.propertyId = mapping.propertyId
              const current = byProperty.get(mapping.propertyId) ?? { ...mapping, amountOre: 0 }
              current.amountOre = addOre(current.amountOre, amountOre)
              byProperty.set(mapping.propertyId, current)
            } else {
              provenance.bucket = 'UNMAPPED'
              const dimensionKey = `${dimensionType}:${code}`
              const current = unmapped.get(dimensionKey) ?? { dimensionType, code, amountOre: 0 }
              current.amountOre = addOre(current.amountOre, amountOre)
              unmapped.set(dimensionKey, current)
            }
          } else {
            unallocated = addOre(unallocated, amountOre)
          }
          rows.push(provenance)
        }
      } catch (error) {
        // Ett avbrutet add kan ha uppdaterat tidigare delsummor. Kärnan är då
        // slutligt felad; en caller får inte få COMPLETE genom att fånga felet.
        failure = { error }
        throw error
      }
    },
    finish() {
      if (failure) throw failure.error
      // Slutvarningar kopieras, så två finish-anrop inte dubblerar dem i basen.
      const uncertainties = [...base.uncertainties]
      if (unmapped.size) {
        uncertainties.push(
          `${unmapped.size} Fortnox-dimension(er) saknar koppling till fastighet och redovisas som okopplade.`,
        )
      }
      if (eveno) {
        uncertainties.push(
          'En del av beloppet kommer från verifikat som Eveno själv har exporterat; lägg inte ihop det med Evenos egna siffror.',
        )
      }
      uncertainties.push(LIMITATION)
      return {
        ...base,
        status: uncertain ? 'COMPLETE_WITH_UNCERTAINTY' : 'COMPLETE',
        reason: null,
        summary: {
          currency: 'SEK',
          totalOre: total,
          byProperty: [...byProperty.values()]
            .map((value) => ({ ...value }))
            .sort((left, right) => left.propertyName.localeCompare(right.propertyName, 'sv')),
          unmappedDimensions: [...unmapped.values()]
            .map((value) => ({ ...value }))
            .sort((left, right) => left.code.localeCompare(right.code, 'sv')),
          unallocatedOre: unallocated,
          uncertainRemovedOre: removed,
          evenoExportOre: eveno,
        },
        rows: rows.map((row) => ({ ...row })),
        references: base.references.map((reference) => ({ ...reference })),
        uncertainties,
      }
    },
  }
}
