import { useState } from 'react'
import { Plus, Wallet } from 'lucide-react'

import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { useCanWrite } from '@/hooks/useCanWrite'
import { isForbidden } from '@/lib/api'

import { useBankAccounts } from '../hooks/useReconciliation'
import { BankAccountForm, ImportkontoForklaring } from './BankAccountForm'

/**
 * K1 — IMPORTKONTONA, SYNLIGA OCH HANTERBARA PÅ AVSTÄMNINGSSIDAN.
 *
 * Fram till nu fanns kontona bara som en `<select>` inuti importmodalen. En
 * organisation utan konton kunde därför inte ens se att något saknades förrän
 * den öppnade importen — och där fanns ingen väg vidare.
 *
 * ── VAD "HANTERA" BETYDER HÄR, OCH VARFÖR DET INTE ÄR MER ───────────────────
 *
 * Endast de endpoints som redan finns: `GET /reconciliation/bank-accounts` och
 * `POST`. Det finns ingen PATCH och ingen DELETE, alltså finns ingen väg att
 * avveckla eller byta namn på ett konto härifrån. Att bygga en hade krävt nya
 * endpoints, och ett konto bär banktransaktioner och importförsök — en
 * borttagning är inte en UI-detalj.
 *
 * AVVECKLADE KONTON VISAS ändå, märkta. Listan från servern innehåller dem
 * (`isActive: false`), och att dölja dem hade gjort ett konto som finns men inte
 * går att välja till ett osynligt skäl till att importen inte fungerar.
 */
export function BankAccountsCard() {
  const { data: konton, isLoading, isError, error } = useBankAccounts()
  const kanSkriva = useCanWrite()
  const [öppen, setÖppen] = useState(false)

  const nekad = isForbidden(error)
  const aktiva = (konton ?? []).filter((k) => k.isActive)

  return (
    <div
      className="border-line bg-surface mt-6 rounded-2xl border p-4"
      data-testid="bank-accounts-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-4">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl border border-gray-100 bg-gray-50">
            <Wallet size={16} strokeWidth={1.8} className="text-gray-500" />
          </div>
          <div className="min-w-0">
            <p className="text-[13.5px] font-medium text-gray-900">Importkonton</p>
            <ImportkontoForklaring />
          </div>
        </div>
        {kanSkriva && !nekad && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setÖppen(true)}
            data-testid="lagg-till-bankkonto"
          >
            <Plus size={14} /> Lägg till konto
          </Button>
        )}
      </div>

      <div className="mt-3">
        {isLoading ? (
          <p className="text-[12.5px] text-gray-400">Hämtar konton…</p>
        ) : nekad ? (
          <p className="text-[12.5px] text-gray-500">
            Din roll får inte se organisationens bankkonton.
          </p>
        ) : isError ? (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-600">
            Kontona kunde inte hämtas. Ladda om sidan och försök igen.
          </p>
        ) : (konton ?? []).length === 0 ? (
          // TOMT ÄR ETT EGET LÄGE, inte en tom lista. Texten säger vad som
          // saknas OCH vad konsekvensen är — annars läses tomheten som ett fel.
          <p className="text-[12.5px] text-amber-700" data-testid="bank-accounts-tomt">
            Inget konto upplagt än. Importen av kontoutdrag kräver ett namngivet konto
            {kanSkriva ? ' — lägg upp det här.' : '. Be en administratör lägga upp det.'}
          </p>
        ) : (
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-100">
            {(konton ?? []).map((k) => (
              <li
                key={k.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-gray-800">{k.name}</p>
                  {k.accountNumber && (
                    <p className="truncate font-mono text-[11.5px] text-gray-400">
                      {k.accountNumber}
                    </p>
                  )}
                </div>
                {k.isActive ? (
                  <Badge variant="success" dot>
                    Aktivt
                  </Badge>
                ) : (
                  <Badge variant="default" dot>
                    Avvecklat
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
        {/* Flera aktiva konton betyder att importen KRÄVER ett val. Att säga det
            här — och inte bara i importmodalen — gör att operatören vet varför
            hon möts av en tom väljare. */}
        {aktiva.length > 1 && (
          <p className="mt-2 text-[12px] text-gray-400">
            {aktiva.length} aktiva konton — du väljer vilket varje import gäller.
          </p>
        )}
      </div>

      <Modal
        open={öppen}
        onClose={() => setÖppen(false)}
        title="Lägg till importkonto"
        description="Kontot som kontoutdraget kommer från."
        size="sm"
      >
        <BankAccountForm
          befintliga={konton}
          idPrefix="kort-bankkonto"
          onAvbryt={() => setÖppen(false)}
          onSkapat={() => setÖppen(false)}
        />
      </Modal>
    </div>
  )
}
