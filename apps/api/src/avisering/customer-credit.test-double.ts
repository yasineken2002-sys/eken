import { CustomerCreditService } from '../customer-credit/customer-credit.service'
import { PaymentFreshnessService } from '../payment-freshness/payment-freshness.service'
import { AviseringService } from './avisering.service'

type Tillgodogräns = Pick<CustomerCreditService, 'prepareNoticeForSend' | 'findPreparedNotice'>

/** Typkontrollerad gräns för äldre Object.create-riggar utan tillgodopolicy. */
export function automatisktTillgodoGränsAvstängd(): Tillgodogräns {
  return {
    prepareNoticeForSend: async () => null,
    findPreparedNotice: async () => null,
  }
}

type BefintligaBeroenden =
  ConstructorParameters<typeof AviseringService> extends [
    ...infer Dependencies,
    CustomerCreditService,
  ]
    ? Dependencies
    : never

/**
 * Äldre aviprov saknar tillgodopolicy. De elva befintliga beroendena skickas
 * oförändrade till den riktiga tjänsten; endast den nya tillgodogränsen är
 * avstängd. Inkopplat tillgodo och utskicksreservation mäts i egna DB-prov.
 */
export function aviseringUtanAutomatisktTillgodo(
  ...dependencies: BefintligaBeroenden
): AviseringService {
  const freshness = new PaymentFreshnessService(dependencies[0], dependencies[2])
  const credit = Object.assign(
    new CustomerCreditService(dependencies[0], dependencies[6], freshness),
    automatisktTillgodoGränsAvstängd(),
  )
  return new AviseringService(...dependencies, credit)
}
