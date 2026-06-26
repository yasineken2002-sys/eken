import { Badge } from '@/components/ui/Badge'
import type { MiscChargeStatus } from '@eken/shared'

// Status-badge för en debiterbar post (teknisk förvaltning). DRAFT = ej bokförd,
// CONFIRMED = verifikat skapat (1510-fordran), ATTACHED = på avi/faktura (PR 4b),
// CANCELLED = annullerad (motverifikat).
export function MiscChargeBadge({ status }: { status: MiscChargeStatus }) {
  const map: Record<
    MiscChargeStatus,
    { label: string; variant: 'warning' | 'success' | 'info' | 'danger' }
  > = {
    DRAFT: { label: 'Utkast (ej bokförd)', variant: 'warning' },
    CONFIRMED: { label: 'Bokförd', variant: 'success' },
    ATTACHED: { label: 'På avi', variant: 'info' },
    CANCELLED: { label: 'Annullerad', variant: 'danger' },
  }
  const { label, variant } = map[status] ?? { label: status, variant: 'info' as const }
  return (
    <Badge variant={variant} dot>
      {label}
    </Badge>
  )
}
