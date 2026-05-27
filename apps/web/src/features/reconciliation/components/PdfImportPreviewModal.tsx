import { useMemo, useState } from 'react'
import { CheckCircle2, Sparkles, Trash2, AlertTriangle } from 'lucide-react'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { formatCurrency } from '@eken/shared'
import { cn } from '@/lib/cn'
import type { ParsedTransaction, PdfImportDraft } from '../api/reconciliation.api'
import { useConfirmPdfImport, useCancelPdfImport } from '../hooks/useReconciliation'

interface Props {
  draft: PdfImportDraft
  onClose: () => void
  onConfirmed: (summary: {
    created: number
    autoMatched: number
    unmatched: number
    duplicates: number
  }) => void
}

// Redigeringsbar rad — fil-OCR:n och beskrivningen kan ändras av användaren
// innan commit. Belopp och datum kan också justeras (t.ex. om AI tolkat
// fel datumformat).
interface EditableRow extends ParsedTransaction {
  _id: number // lokal nyckel; vi sparar inte detta till backend
  _removed: boolean
}

function buildRows(transactions: ParsedTransaction[]): EditableRow[] {
  return transactions.map((t, i) => ({ ...t, _id: i, _removed: false }))
}

export function PdfImportPreviewModal({ draft, onClose, onConfirmed }: Props) {
  const [rows, setRows] = useState<EditableRow[]>(() => buildRows(draft.parsed.transactions))
  const confirmMut = useConfirmPdfImport()
  const cancelMut = useCancelPdfImport()

  const incomingActive = useMemo(() => rows.filter((r) => !r._removed && r.amount > 0), [rows])
  const outgoingCount = useMemo(
    () => rows.filter((r) => !r._removed && r.amount <= 0).length,
    [rows],
  )
  const totalIncomingAmount = useMemo(
    () => incomingActive.reduce((sum, r) => sum + r.amount, 0),
    [incomingActive],
  )

  const updateRow = (id: number, patch: Partial<EditableRow>) => {
    setRows((prev) => prev.map((r) => (r._id === id ? { ...r, ...patch } : r)))
  }

  const handleConfirm = () => {
    // Skickar HELA listan (utom borttagna). Backend filtrerar bort uttag i
    // commit-fasen (samma policy som CSV-importen — bara inbetalningar
    // skapar BankTransaction-rader).
    const final: ParsedTransaction[] = rows
      .filter((r) => !r._removed)
      .map(({ _id: _unusedId, _removed: _unusedRemoved, ...rest }) => {
        void _unusedId
        void _unusedRemoved
        return rest
      })
    confirmMut.mutate(
      { importId: draft.id, transactions: final },
      {
        onSuccess: (data) => {
          onConfirmed({
            created: data.created,
            autoMatched: data.autoMatched,
            unmatched: data.unmatched,
            duplicates: data.duplicates,
          })
        },
      },
    )
  }

  const handleCancel = () => {
    cancelMut.mutate(draft.id, { onSuccess: onClose })
  }

  const { bank, periodStart, periodEnd, accountNumber } = draft.parsed

  return (
    <Modal open onClose={onClose} title="Granska AI-tolkade transaktioner" size="xl">
      {/* Metadata-banner */}
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-blue-100 bg-blue-50/60 px-4 py-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600/10">
          <Sparkles size={16} className="text-blue-600" strokeWidth={1.8} />
        </div>
        <div className="flex-1">
          <p className="text-[12.5px] font-semibold text-blue-800">
            Claude tolkade {draft.parsed.transactions.length} rader från PDF:en
          </p>
          <p className="text-[11.5px] text-blue-700/80">
            {bank ?? 'Okänd bank'}
            {accountNumber ? ` · ${accountNumber}` : ''}
            {periodStart && periodEnd ? ` · ${periodStart} – ${periodEnd}` : ''}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[11px] uppercase tracking-wide text-blue-700/70">
            Inbetalningar att importera
          </p>
          <p className="text-[15px] font-semibold text-blue-800">
            {incomingActive.length} st · {formatCurrency(totalIncomingAmount)}
          </p>
        </div>
      </div>

      {/* Hint */}
      <p className="mb-2 flex items-center gap-1.5 text-[12px] text-gray-500">
        <AlertTriangle size={12} className="text-amber-500" />
        Endast inbetalningar (gröna belopp) skapas som transaktioner. Uttag visas för översikt och
        hoppas över vid bekräftelse.
      </p>

      {/* Tabell */}
      <div className="max-h-[420px] overflow-y-auto rounded-xl border border-[#EAEDF0]">
        <table className="w-full text-[12.5px]">
          <thead className="sticky top-0 bg-white">
            <tr className="border-b border-[#EAEDF0]">
              {['Datum', 'Beskrivning', 'OCR', 'Belopp', ''].map((h) => (
                <th
                  key={h}
                  className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isIncoming = r.amount > 0
              const isRemoved = r._removed
              return (
                <tr
                  key={r._id}
                  className={cn(
                    'border-b border-[#EAEDF0] last:border-0',
                    isRemoved && 'line-through opacity-40',
                  )}
                >
                  <td className="px-3 py-2 text-gray-600">
                    <input
                      value={r.date}
                      onChange={(e) => updateRow(r._id, { date: e.target.value })}
                      className="w-28 rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-[#DDDFE4] focus:border-blue-500 focus:bg-white focus:outline-none"
                      disabled={isRemoved}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      value={r.description}
                      onChange={(e) => updateRow(r._id, { description: e.target.value })}
                      className="w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-gray-800 hover:border-[#DDDFE4] focus:border-blue-500 focus:bg-white focus:outline-none"
                      disabled={isRemoved}
                    />
                  </td>
                  <td className="px-3 py-2 font-mono">
                    <input
                      value={r.ocr ?? ''}
                      placeholder="—"
                      onChange={(e) => updateRow(r._id, { ocr: e.target.value || null })}
                      className="w-32 rounded border border-transparent bg-transparent px-1 py-0.5 text-gray-700 hover:border-[#DDDFE4] focus:border-blue-500 focus:bg-white focus:outline-none"
                      disabled={isRemoved}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      step="0.01"
                      value={r.amount}
                      onChange={(e) =>
                        updateRow(r._id, { amount: parseFloat(e.target.value) || 0 })
                      }
                      className={cn(
                        'w-24 rounded border border-transparent bg-transparent px-1 py-0.5 text-right font-semibold hover:border-[#DDDFE4] focus:border-blue-500 focus:bg-white focus:outline-none',
                        isIncoming ? 'text-emerald-600' : 'text-gray-400',
                      )}
                      disabled={isRemoved}
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => updateRow(r._id, { _removed: !isRemoved })}
                      className={cn(
                        'rounded p-1 transition-colors',
                        isRemoved
                          ? 'text-blue-600 hover:bg-blue-50'
                          : 'text-gray-400 hover:bg-red-50 hover:text-red-600',
                      )}
                      title={isRemoved ? 'Återställ rad' : 'Ta bort rad'}
                    >
                      {isRemoved ? <CheckCircle2 size={13} /> : <Trash2 size={13} />}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center justify-between text-[11.5px] text-gray-500">
        <span>
          {outgoingCount > 0
            ? `${outgoingCount} uttag visas men kommer inte att importeras`
            : 'Inga uttag i denna fil'}
        </span>
        <span>Belopp- och OCR-fältet kan redigeras direkt — klicka på cellen</span>
      </div>

      {confirmMut.isError && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-600">
          Bekräftelse misslyckades. Försök igen.
        </p>
      )}

      <ModalFooter>
        <Button variant="ghost" onClick={handleCancel} loading={cancelMut.isPending}>
          Avbryt
        </Button>
        <Button
          variant="primary"
          onClick={handleConfirm}
          loading={confirmMut.isPending}
          disabled={incomingActive.length === 0}
        >
          <CheckCircle2 size={14} /> Bekräfta & matcha {incomingActive.length} inbetalningar
        </Button>
      </ModalFooter>
    </Modal>
  )
}
