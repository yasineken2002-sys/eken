import { CustomerCreditService } from '../customer-credit/customer-credit.service'
import { ReconciliationService } from './reconciliation.service'

type Tillgodogräns = Pick<
  CustomerCreditService,
  | 'isReceiptEnabled'
  | 'assertBankCanBeUnmatchedInTransaction'
  | 'lockReceiptInTransaction'
  | 'recordReceiptInTransaction'
>

/** Samma typkontrollerade gräns för äldre riggar som använder Object.create. */
export function kundtillgodoGränsAvstängd(): Tillgodogräns {
  return {
    isReceiptEnabled: async () => false,
    // De här fixturerna har inget kundtillgodo att skydda vid avmatchning.
    assertBankCanBeUnmatchedInTransaction: async () => undefined,
    lockReceiptInTransaction: async () => {
      throw new Error('Oväntat tillgodolås: testfixturens tillgodopolicy är avstängd')
    },
    recordReceiptInTransaction: async () => {
      throw new Error('Oväntad tillgodomottagning: testfixturens tillgodopolicy är avstängd')
    },
  }
}

/**
 * De äldre fixturerna saknar tillgodopolicy och prövar den befintliga
 * avstämningen. Bara tillgodogränsen är avstängd; de nio tidigare beroendena
 * skickas oförändrade till den riktiga ReconciliationService.
 *
 * Den inkopplade tillgodovägen prövas med riktiga tjänster och PostgreSQL i
 * customer-credit-bank-import.db.spec.ts. Den här dubbeln bevisar inte den.
 */
export function kundtillgodoAvstängt(
  ...dependencies: ConstructorParameters<typeof CustomerCreditService>
): CustomerCreditService {
  return Object.assign(new CustomerCreditService(...dependencies), kundtillgodoGränsAvstängd())
}

type BefintligaBeroenden =
  ConstructorParameters<typeof ReconciliationService> extends [
    ...infer Dependencies,
    CustomerCreditService,
  ]
    ? Dependencies
    : never

export function reconciliationUtanKundtillgodo(
  ...dependencies: BefintligaBeroenden
): ReconciliationService {
  return new ReconciliationService(
    ...dependencies,
    kundtillgodoAvstängt(dependencies[0], dependencies[3], dependencies[4]),
  )
}
