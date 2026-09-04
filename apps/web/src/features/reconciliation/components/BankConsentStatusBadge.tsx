import { Badge } from '@/components/ui/Badge'
import type { BankConsentStatus } from '../api/psd2.api'

type Variant = 'success' | 'warning' | 'danger' | 'default'

/**
 * `BankConsentStatus` → etikett och variant. Uttömmande Record, inte partial:
 * en femte statuskod i schemat blir ett TYPFEL här i stället för en rå
 * enum-sträng i gränssnittet.
 *
 * VARFÖR REVOKED ÄR NEUTRAL OCH INTE RÖD: ett återkallat samtycke är oftast
 * hyresvärdens egen handling — hen tryckte på knappen. Rött är reserverat för
 * något som gått fel och kräver åtgärd. EXPIRED är gult därför att det KRÄVER en
 * handling (PSD2 tvingar omcertifiering ~var 90:e dag), och ERROR är rött
 * därför att banken rapporterat ett fel som pausar inflödet.
 *
 * Blått står inte i tabellen, och det är inte ett förbiseende: `info` är
 * neutralskalans grå sedan färgflippen (F5), och `bg-blue-*` slår numera upp
 * varumärkesgrönt. En status som inte påstår något om utfallet ska ha
 * neutralgrått, inte en signalfärg.
 */
const KARTA: Record<BankConsentStatus, { etikett: string; variant: Variant }> = {
  ACTIVE: { etikett: 'Aktiv', variant: 'success' },
  EXPIRED: { etikett: 'Utgången', variant: 'warning' },
  REVOKED: { etikett: 'Återkallad', variant: 'default' },
  ERROR: { etikett: 'Fel', variant: 'danger' },
}

export function bankConsentStatusVisning(status: BankConsentStatus) {
  return KARTA[status]
}

export function BankConsentStatusBadge({ status }: { status: BankConsentStatus }) {
  const { etikett, variant } = KARTA[status]
  return (
    <Badge variant={variant} dot>
      {etikett}
    </Badge>
  )
}
