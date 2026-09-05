import { useState } from 'react'
import { Send } from 'lucide-react'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { formatCurrency, formatDate } from '@eken/shared'

/**
 * MARKERA SOM SKICKAD TILL INKASSO — människans väg till
 * `mark_sent_to_collection`.
 *
 * Verktyget stod i baslinjen med skälet att endpointen finns och att
 * `markSentToCollection` är exporterad ur `collections.api.ts` — men att INGEN
 * komponent importerar den. Funktionen var död i gränssnittet, "vilket ser ut
 * som en väg i en sökning och inte är en".
 *
 * ── GRINDEN LIGGER I TJÄNSTEN, INTE HÄR ─────────────────────────────────────
 *
 * `CollectionExportService.markSentToCollection` grindar på FAKTISK skuld
 * (INV-D) och på rollen. Modalen upprepar ingen av de kontrollerna: en andra
 * kopia i UI:t hade blivit en andra sanning som avviker den dag grinden ändras,
 * och den som ser en aktiv knapp hade trott att åtgärden var tillåten.
 * Nekas den svarar servern, och felet visas här.
 *
 * ── VARFÖR STEGET ÄR BINDANDE ───────────────────────────────────────────────
 *
 * Markeringen säger att ärendet ÄR överlämnat till inkassobolaget. Den pausar
 * påminnelser och flyttar fakturan ur kravtrappan — och den är ett påstående om
 * något som skett utanför systemet. Att klicka fel här betyder att en hyresgäst
 * slutar få påminnelser för ett ärende ingen faktiskt skickade.
 *
 * Därför `danger`-varianten och en bekräftelse som visar fakturan, mottagaren
 * och beloppet i klartext.
 */

export interface InkassoFaktura {
  id: string
  invoiceNumber: string
  tenantName: string
  /**
   * FAKTURABELOPPET, inte restskulden. `OverdueInvoice` bär `total` och inget
   * annat beloppsfält — och att kalla det "restskuld" hade varit precis det fel
   * kodbasen redan lagat på fem ställen (#325/#329/#344). Grinden på FAKTISK
   * skuld (INV-D) ligger i tjänsten och räknar sitt eget tal; det här är en
   * identifierande uppgift i bekräftelsen, inte ett underlag för beslutet.
   */
  total: number
  dueDate: string
}

interface Props {
  open: boolean
  onClose: () => void
  faktura: InkassoFaktura | null
  onBekrafta: (note: string | undefined) => void
  arbetar: boolean
  fel: string | null
}

export function MarkSentToCollectionModal({
  open,
  onClose,
  faktura,
  onBekrafta,
  arbetar,
  fel,
}: Props) {
  const [note, setNote] = useState('')

  const stang = () => {
    setNote('')
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={stang}
      title="Markera som skickad till inkasso"
      description="Bekräfta att ärendet är överlämnat till inkassobolaget."
    >
      <div className="space-y-4">
        {faktura && (
          <dl
            className="border-line space-y-2.5 rounded-2xl border p-4"
            data-testid="mark-sent-summary"
          >
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-[12px] text-gray-400">Faktura</dt>
              <dd className="text-[13px] font-medium text-gray-900">{faktura.invoiceNumber}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-[12px] text-gray-400">Hyresgäst</dt>
              <dd className="text-right text-[13px] text-gray-900">{faktura.tenantName}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-[12px] text-gray-400">Förföll</dt>
              <dd className="text-[13px] text-gray-700">{formatDate(faktura.dueDate)}</dd>
            </div>
            <div className="border-line flex items-baseline justify-between gap-4 border-t pt-2.5">
              <dt className="text-[12px] text-gray-400">Fakturabelopp</dt>
              <dd className="text-[13px] font-medium text-gray-900">
                {formatCurrency(faktura.total)}
              </dd>
            </div>
          </dl>
        )}

        <p className="border-line rounded-xl border bg-gray-50/60 px-4 py-3 text-[12px] text-gray-500">
          Påminnelser pausas och fakturan lämnar kravtrappan. Markeringen är ett påstående om något
          som skett utanför Eveno — gör den först när underlaget faktiskt är överlämnat.
        </p>

        <Input
          label="Anteckning (valfri)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="t.ex. ärendenummer hos inkassobolaget"
          data-testid="mark-sent-note"
        />

        {fel && (
          <p
            className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] text-red-600"
            data-testid="mark-sent-error"
          >
            {fel}
          </p>
        )}
      </div>

      <ModalFooter>
        <Button variant="secondary" onClick={stang}>
          Avbryt
        </Button>
        <Button
          variant="danger"
          onClick={() => onBekrafta(note.trim() || undefined)}
          disabled={arbetar || !faktura}
          data-testid="mark-sent-confirm"
        >
          <Send size={14} strokeWidth={1.8} />
          {arbetar ? 'Markerar…' : 'Markera som skickad'}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
