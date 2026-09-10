import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { ConfirmConsumptionChargeSchema } from '@eken/shared'
import type { ConfirmConsumptionChargeInput } from '@eken/shared'
import { Button } from '@/components/ui/Button'
import { fetchChargeControl } from '../api/charges.api'
import { useConfirmCharge } from '../hooks/useChargeQueries'

export function ChargeControlPanel({
  chargeId,
  onReview,
}: {
  chargeId: string
  onReview: () => void
}) {
  const [acceptedFingerprint, setAcceptedFingerprint] = useState<string | null>(null)
  const check = useQuery({
    queryKey: ['charge-control', chargeId],
    queryFn: () => fetchChargeControl(chargeId),
  })
  const confirm = useConfirmCharge()
  const control = check.data
  const error = axios.isAxiosError(confirm.error)
    ? confirm.error.response?.data?.error?.message
    : null
  return (
    <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-sm">
      <p className="font-semibold">Kontroll före debitering</p>
      {check.isError && <p role="alert">Kontrollen kunde inte läsas. Läs om och försök igen.</p>}
      {control && (
        <>
          <p>Avläsning {control.readingId}</p>
          {control.allowed ? (
            <p>
              Inga blockerande varningar i denna kontroll. Det betyder inte att alla trendkontroller
              kunde utföras.
            </p>
          ) : (
            <div role="alert">
              {control.problems.map((p) => (
                <p key={p}>{p}</p>
              ))}
            </div>
          )}
          {control.hasCurrentCheck && (
            <p>
              Senast kontrollerad av {control.checkedByName}. Ny kontroll görs också före koppling
              till avi eller faktura.
            </p>
          )}
          {!control.allowed && <Button onClick={onReview}>Öppna Granskning</Button>}
          <p>
            Konfirmering bokför kundfordran och intäkt när posten har ett belopp och kontoplanen är
            konfigurerad. En tidigare bokförd post får ingen dubbel verifikation. Felaktig avläsning
            är fortsatt spärrad; rättelsevägen är ett separat kommande bygge.
          </p>
          {control.allowed && (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={acceptedFingerprint === control.fingerprint}
                onChange={(e) =>
                  setAcceptedFingerprint(e.target.checked ? control.fingerprint : null)
                }
              />
              Jag har läst denna kontroll och vill konfirmera debiteringen.
            </label>
          )}
        </>
      )}
      {confirm.isError && (
        <p role="alert">
          {typeof error === 'string'
            ? error
            : 'Konfirmeringen kunde inte sparas. Läs om kontrollen och försök igen.'}
        </p>
      )}
      {confirm.isSuccess && <p role="status">Kontrollen och konfirmeringen har sparats.</p>}
      <div className="flex gap-2">
        <Button
          onClick={() => {
            setAcceptedFingerprint(null)
            confirm.reset()
            void check.refetch()
          }}
          disabled={confirm.isPending}
        >
          Läs om kontrollen
        </Button>
        <Button
          variant="primary"
          loading={confirm.isPending}
          disabled={
            !control?.allowed ||
            acceptedFingerprint !== control.fingerprint ||
            check.isFetching ||
            confirm.isError
          }
          onClick={() => {
            if (!control || acceptedFingerprint !== control.fingerprint) return
            const dto: ConfirmConsumptionChargeInput = { expectedFingerprint: acceptedFingerprint }
            confirm.mutate({ id: chargeId, dto: ConfirmConsumptionChargeSchema.parse(dto) })
          }}
        >
          Bekräfta och bokför
        </Button>
      </div>
    </div>
  )
}
