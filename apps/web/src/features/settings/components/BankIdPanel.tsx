import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldCheck, Trash2 } from 'lucide-react'
import { formatDate } from '@eken/shared'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { extractApiError } from '@/lib/api'
import { usePublicFeatures } from '@/lib/public-config'
import { BankIdModal } from '@/features/auth/components/BankIdModal'
import { useBankIdEnroll } from '@/features/auth/hooks/useBankIdFlow'
import { bankIdIdentities, bankIdRemoveIdentity } from '@/features/auth/api/bankid.api'

const NYCKEL = ['bankid-identities'] as const

/**
 * "Koppla BankID" på säkerhetsfliken.
 *
 * ── INGEN ROLLGRIND, OCH DET ÄR ETT BESLUT ────────────────────────────────
 *
 * Att koppla sitt eget BankID är en handling på DET EGNA KONTOT, som att byta
 * lösenord — inte en förvaltningshandling. Varje roll ska kunna göra det, och
 * API-sidan är klassificerad likadant: de fyra endpointsen står i
 * GRANSKAD_HINK_A med just det skälet. En rollgrind här hade dessutom varit
 * kosmetisk, eftersom endpointen ändå är öppen för alla inloggade.
 *
 * ── VAD SOM VISAS, OCH VAD SOM INTE GÖR DET ───────────────────────────────
 *
 * Bara datumet. Personnumret finns inte att visa — det lagras krypterat och
 * blindindexerat, och varken hash eller chiffertext lämnar servern. Att visa
 * "•••••-••••" hade antytt att vi har det tillgängligt.
 */
export function BankIdPanel() {
  const { bankId } = usePublicFeatures()
  const qc = useQueryClient()
  const { state, starta, avbryt } = useBankIdEnroll()
  const [fel, setFel] = useState<string | null>(null)

  const { data: identiteter = [], isLoading } = useQuery({
    queryKey: NYCKEL,
    queryFn: bankIdIdentities,
    enabled: bankId,
  })

  const koppplaBort = useMutation({
    mutationFn: bankIdRemoveIdentity,
    onSuccess: () => {
      setFel(null)
      void qc.invalidateQueries({ queryKey: NYCKEL })
    },
    onError: (err: unknown) => setFel(extractApiError(err, 'Kunde inte koppla bort BankID')),
  })

  // En fullbordad anslutning bär ingen session (`session: null`) — det är
  // skillnaden mot inloggningsflödet. Listan hämtas om, och modalen stängs.
  useEffect(() => {
    if (state.steg !== 'klar') return
    void qc.invalidateQueries({ queryKey: NYCKEL })
    avbryt()
  }, [state.steg, qc, avbryt])

  if (!bankId) return null

  return (
    <section className="rounded-2xl border border-gray-100 bg-white p-5">
      <div className="mb-4 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-50">
          <ShieldCheck size={13} strokeWidth={1.8} className="text-blue-600" />
        </div>
        <h2 className="text-[14px] font-semibold text-gray-800">BankID</h2>
      </div>

      <p className="text-[13px] text-gray-500">
        Koppla ditt BankID till kontot så kan du logga in med det i stället för lösenord. Ditt
        personnummer lagras krypterat och visas aldrig.
      </p>

      {isLoading ? (
        <p className="mt-4 text-[13px] text-gray-400">Hämtar…</p>
      ) : identiteter.length === 0 ? (
        <div className="mt-4">
          <Button variant="primary" size="sm" onClick={starta} data-testid="bankid-connect">
            <ShieldCheck size={13} strokeWidth={1.8} className="mr-1.5" />
            Koppla BankID
          </Button>
        </div>
      ) : (
        <ul className="mt-4 space-y-2">
          {identiteter.map((rad) => (
            <li
              key={rad.id}
              className="flex items-center justify-between rounded-xl border border-gray-100 bg-gray-50/60 px-4 py-3"
              data-testid="bankid-identity"
            >
              <span className="flex items-center gap-2.5">
                <Badge variant="success" dot>
                  Kopplad
                </Badge>
                <span className="text-[13px] text-gray-600">{formatDate(rad.verifiedAt)}</span>
              </span>
              <Button
                variant="ghost"
                size="xs"
                loading={koppplaBort.isPending}
                onClick={() => koppplaBort.mutate(rad.id)}
                data-testid="bankid-disconnect"
              >
                <Trash2 size={13} strokeWidth={1.8} className="mr-1.5" />
                Koppla bort
              </Button>
            </li>
          ))}
        </ul>
      )}

      {fel && <p className="mt-3 text-[12px] text-red-500">{fel}</p>}

      <BankIdModal
        open={state.steg !== 'inaktiv' && state.steg !== 'klar'}
        onClose={avbryt}
        state={state}
        title="Koppla BankID"
        description="Legitimera dig med BankID för att koppla det till ditt konto."
        onRetry={starta}
      />
    </section>
  )
}
