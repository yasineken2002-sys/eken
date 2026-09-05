import { useMemo, useState } from 'react'
import { Send, User } from 'lucide-react'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { useTenants } from '@/features/tenants/hooks/useTenants'
import { useSendDocumentToTenant } from '../hooks/useDocuments'
import { extractApiError } from '@/lib/api'

/**
 * SKICKA TILL HYRESGÄST — människans väg till `send_document_to_tenant`.
 *
 * ── BEKRÄFTELSEN VISAR VEM SOM FÅR VAD ──────────────────────────────────────
 *
 * Leveransen är utåtriktad: dokumentet hamnar i en annan människas portal och
 * ett mejl går iväg. Den sortens åtgärd får inte utlösas av ett klick på en rad
 * i en lista — steg två visar mottagarens namn, adress och dokumentets namn i
 * klartext innan något skickas.
 *
 * Det är inte artighet utan riktningen på felet: en felskickad handling går inte
 * att ta tillbaka från hyresgästens inkorg, och listan sorteras om när man
 * filtrerar.
 *
 * ── VERKTYGETS DISAMBIGUERING, ÖVERSATT TILL ETT GRÄNSSNITT ─────────────────
 *
 * AI-verktyget löser upp hyresgästen ur ett namn och VÄGRAR gissa vid fler än en
 * träff — den frågar i stället. Gränssnittet har samma egenskap gratis genom att
 * mottagaren väljs ur en lista: det finns inget namn att tolka. Sökfältet
 * filtrerar bara vad som visas; valet är alltid ett id.
 */

interface Props {
  open: boolean
  onClose: () => void
  documentId: string
  documentName: string
}

type Steg = 'valj' | 'bekrafta'

export function SendToTenantModal({ open, onClose, documentId, documentName }: Props) {
  const [steg, setSteg] = useState<Steg>('valj')
  const [sok, setSok] = useState('')
  const [valdId, setValdId] = useState<string | null>(null)
  const [notifiera, setNotifiera] = useState(true)
  const [serverfel, setServerfel] = useState<string | null>(null)

  const { data: tenants = [], isLoading } = useTenants()
  const mutation = useSendDocumentToTenant()

  const visningsnamn = (t: {
    type: string
    firstName?: string | null
    lastName?: string | null
    companyName?: string | null
  }) =>
    t.type === 'INDIVIDUAL'
      ? `${t.firstName ?? ''} ${t.lastName ?? ''}`.trim()
      : (t.companyName ?? '')

  const traffar = useMemo(() => {
    const q = sok.trim().toLowerCase()
    const aktiva = tenants.filter((t) => !t.anonymizedAt)
    if (!q) return aktiva.slice(0, 50)
    return aktiva
      .filter((t) => visningsnamn(t).toLowerCase().includes(q) || t.email.toLowerCase().includes(q))
      .slice(0, 50)
  }, [tenants, sok])

  const vald = tenants.find((t) => t.id === valdId) ?? null

  const stang = () => {
    setSteg('valj')
    setSok('')
    setValdId(null)
    setNotifiera(true)
    setServerfel(null)
    onClose()
  }

  const skicka = () => {
    if (!vald) return
    setServerfel(null)
    mutation.mutate(
      { documentId, tenantId: vald.id, notify: notifiera },
      {
        onSuccess: stang,
        onError: (err) => setServerfel(extractApiError(err, 'Kunde inte skicka dokumentet')),
      },
    )
  }

  return (
    <Modal
      open={open}
      onClose={stang}
      title="Skicka till hyresgäst"
      description={
        steg === 'valj'
          ? 'Dokumentet läggs i hyresgästens portal.'
          : 'Kontrollera mottagaren innan du skickar.'
      }
    >
      {steg === 'valj' ? (
        <div className="space-y-4">
          <div className="border-line rounded-xl border bg-gray-50/60 px-4 py-3">
            <p className="text-[12px] text-gray-400">Dokument</p>
            <p className="text-[13.5px] font-medium text-gray-900">{documentName}</p>
          </div>

          <Input
            label="Sök hyresgäst"
            value={sok}
            onChange={(e) => setSok(e.target.value)}
            placeholder="Namn eller e-post"
            data-testid="send-doc-search"
          />

          <div className="border-line max-h-64 overflow-y-auto rounded-xl border">
            {isLoading ? (
              <p className="px-4 py-3 text-[13px] text-gray-400">Hämtar hyresgäster…</p>
            ) : traffar.length === 0 ? (
              <p className="px-4 py-3 text-[13px] text-gray-400">
                Ingen hyresgäst matchar sökningen.
              </p>
            ) : (
              traffar.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setValdId(t.id)}
                  className={
                    valdId === t.id
                      ? 'flex w-full items-center gap-3 border-b border-[var(--ev-row-border)] bg-gray-100 px-4 py-2.5 text-left last:border-0'
                      : 'flex w-full items-center gap-3 border-b border-[var(--ev-row-border)] px-4 py-2.5 text-left last:border-0 hover:bg-[var(--ev-row-hover)]'
                  }
                  data-testid={`send-doc-tenant-${t.id}`}
                >
                  <User size={14} strokeWidth={1.8} className="flex-shrink-0 text-gray-400" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] text-gray-900">
                      {visningsnamn(t)}
                    </span>
                    <span className="block truncate text-[12px] text-gray-400">{t.email}</span>
                  </span>
                  {valdId === t.id && <Badge variant="success">Vald</Badge>}
                </button>
              ))
            )}
          </div>

          <label className="flex items-center gap-2.5 text-[13px] text-gray-700">
            <input
              type="checkbox"
              checked={notifiera}
              onChange={(e) => setNotifiera(e.target.checked)}
              className="h-4 w-4 rounded"
              data-testid="send-doc-notify"
            />
            Skicka även en e-postnotis om att dokumentet finns
          </label>
        </div>
      ) : (
        <div className="space-y-4" data-testid="send-doc-confirm">
          {/* Steg två visar HELA handlingen i klartext: vad, till vem, och om
              ett mejl går iväg. Ett dokument i fel hyresgästs portal går inte
              att ta tillbaka. */}
          <dl className="border-line space-y-2.5 rounded-2xl border p-4">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-[12px] text-gray-400">Dokument</dt>
              <dd className="text-right text-[13px] font-medium text-gray-900">{documentName}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-[12px] text-gray-400">Mottagare</dt>
              <dd className="text-right text-[13px] text-gray-900">
                {vald ? visningsnamn(vald) : '–'}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-[12px] text-gray-400">E-post</dt>
              <dd className="text-right text-[13px] text-gray-700">{vald?.email ?? '–'}</dd>
            </div>
            <div className="border-line flex items-baseline justify-between gap-4 border-t pt-2.5">
              <dt className="text-[12px] text-gray-400">Notis</dt>
              <dd className="text-right text-[13px] text-gray-700">
                {notifiera ? 'Ett mejl skickas till hyresgästen' : 'Inget mejl skickas'}
              </dd>
            </div>
          </dl>

          {serverfel && (
            <p className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] text-red-600">
              {serverfel}
            </p>
          )}
        </div>
      )}

      <ModalFooter>
        {steg === 'valj' ? (
          <>
            <Button variant="secondary" onClick={stang}>
              Avbryt
            </Button>
            <Button
              variant="primary"
              onClick={() => setSteg('bekrafta')}
              disabled={!vald}
              data-testid="send-doc-next"
            >
              Fortsätt
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={() => setSteg('valj')}>
              Tillbaka
            </Button>
            <Button
              variant="primary"
              onClick={skicka}
              disabled={mutation.isPending}
              data-testid="send-doc-submit"
            >
              <Send size={14} strokeWidth={1.8} />
              {mutation.isPending ? 'Skickar…' : 'Skicka'}
            </Button>
          </>
        )}
      </ModalFooter>
    </Modal>
  )
}
