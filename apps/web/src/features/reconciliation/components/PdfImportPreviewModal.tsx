import { useMemo, useState } from 'react'
import { CheckCircle2, Sparkles, Trash2, AlertTriangle } from 'lucide-react'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { formatCurrency } from '@eken/shared'
import { cn } from '@/lib/cn'
import type { ParsedTransaction, PdfImportDraft } from '../api/reconciliation.api'
import { importmål, kontolistläge, tolkaImportPagar } from '../api/reconciliation.api'
import {
  useConfirmPdfImport,
  useCancelPdfImport,
  useBankAccounts,
} from '../hooks/useReconciliation'

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
  // #F034b — 409 IMPORT_PAGAR skiljs från övriga fel. Se noten vid felrutan.
  const pagar = tolkaImportPagar(confirmMut.error)
  const cancelMut = useCancelPdfImport()
  // K1 — VILKET KONTO bekräftelsen gäller. Valet gjordes vid uppladdningen och
  // bärs hit i draften; namnet slås upp i den redan cachade kontolistan så att
  // operatören ser VAD hon bekräftar mot, inte bara ett id hon aldrig ser.
  //
  // Att visa det är inte pynt: PDF-flödet är två steg, och det är BEKRÄFTELSEN
  // som skriver bankrader. Står det fel konto här är det sista tillfället att
  // upptäcka det.
  const {
    data: bankkonton,
    isPending: kontonLaddar,
    isError: kontonFel,
    refetch: hämtaKontonIgen,
  } = useBankAccounts()
  const målkonto = (bankkonton ?? []).find((k) => k.id === draft.bankAccountId)
  const saknarKonto = !draft.bankAccountId
  // RÄTTNING-1 (G2) — SAMMA grind som CSV/BgMax. Tidigare frågade den här
  // modalen bara om ett id FANNS, trots att den redan hämtade kontolistan: ett
  // konto som avvecklats mellan uppladdning och bekräftelse passerade, och
  // granskaren mätte `submittedAccount: "account-b"` med kontot inaktivt.
  //
  // Ett SAKNAT mål har ett eget besked och går INTE genom `importmål` — ett
  // obestämt mål hade där kunnat lösas upp till "det enda aktiva kontot", och
  // en PDF får aldrig få ett konto tilldelat i efterhand.
  const utfall =
    saknarKonto || !draft.bankAccountId
      ? null
      : importmål(
          kontolistläge({ data: bankkonton, isPending: kontonLaddar, isError: kontonFel }),
          { typ: 'valt', id: draft.bankAccountId },
        )
  const målSpärrat = saknarKonto || utfall?.id == null

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
    // #F034c — kontot valdes vid uppladdningen och bärs hit. Utan det kan
    // bekräftelsen inte göras, och servern skulle avvisa den ändå.
    // RÄTTNING-1 (G2) — samma giltighetsvillkor som knappen: ett mål som blivit
    // inaktivt, borttaget eller okänt får inte skickas.
    if (!draft.bankAccountId || målSpärrat) return
    confirmMut.mutate(
      { importId: draft.id, bankAccountId: draft.bankAccountId, transactions: final },
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

      {/* K1 — MÅLKONTOT, buret från uppladdningen. Kontonumret i raden ovan är
          AI-EXTRAHERAT ur utdraget och väljer aldrig konto; det kontrolleras mot
          valet på servern (`BankAccountService.jamforKontonummer`). Raden här
          säger vad valet VAR. */}
      {!saknarKonto && (
        <p className="mb-2 text-[12px] text-gray-500" data-testid="pdf-malkonto">
          Bokförs mot importkontot{' '}
          <strong className="font-semibold text-gray-700">
            {målkonto ? målkonto.name : 'som valdes vid uppladdningen'}
          </strong>
          {målkonto?.accountNumber ? ` (${målkonto.accountNumber})` : ''}.
        </p>
      )}

      {/* Hint */}
      <p className="mb-2 flex items-center gap-1.5 text-[12px] text-gray-500">
        <AlertTriangle size={12} className="text-amber-500" />
        Endast inbetalningar (gröna belopp) skapas som transaktioner. Uttag visas för översikt och
        hoppas över vid bekräftelse.
      </p>

      {/* Tabell */}
      <div className="border-line max-h-[420px] overflow-y-auto rounded-xl border">
        <table className="w-full text-[12.5px]">
          <thead className="sticky top-0 bg-white">
            <tr className="border-line border-b">
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
                    'border-line border-b last:border-0',
                    isRemoved && 'line-through opacity-40',
                  )}
                >
                  <td className="px-3 py-2 text-gray-600">
                    <input
                      value={r.date}
                      onChange={(e) => updateRow(r._id, { date: e.target.value })}
                      className="hover:border-input w-28 rounded border border-transparent bg-transparent px-1 py-0.5 focus:border-blue-500 focus:bg-white focus:outline-none"
                      disabled={isRemoved}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      value={r.description}
                      onChange={(e) => updateRow(r._id, { description: e.target.value })}
                      className="hover:border-input w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-gray-800 focus:border-blue-500 focus:bg-white focus:outline-none"
                      disabled={isRemoved}
                    />
                  </td>
                  <td className="px-3 py-2 font-mono">
                    <input
                      value={r.ocr ?? ''}
                      placeholder="—"
                      onChange={(e) => updateRow(r._id, { ocr: e.target.value || null })}
                      className="hover:border-input w-32 rounded border border-transparent bg-transparent px-1 py-0.5 text-gray-700 focus:border-blue-500 focus:bg-white focus:outline-none"
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
                        'hover:border-input w-24 rounded border border-transparent bg-transparent px-1 py-0.5 text-right font-semibold focus:border-blue-500 focus:bg-white focus:outline-none',
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

      {/* #F034b — "bekräftelsen pågår redan" är inte ett fel som ska lösas
          genom att trycka igen. Trycker operatören igen på ett faktiskt fel är
          det rätt; gör hen det på ett pågående commit väntar hen i onödan på
          ett andra svar som aldrig kommer. De två måste därför säga olika sak. */}
      {pagar && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[12.5px] text-amber-700">
          {pagar.message}
        </p>
      )}
      {confirmMut.isError && !pagar && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-600">
          Bekräftelse misslyckades. Försök igen.
        </p>
      )}

      {/* K1 — EN AVSTÄNGD KNAPP MED SKÄL, inte en tyst retur. `handleConfirm`
          returnerade utan effekt när draften saknade konto: knappen såg
          användbar ut, klicket gjorde ingenting, och det finns inget sätt för
          operatören att skilja det från en hängning. Draften kan bara sakna
          konto om den kommer från en annan väg än importmodalen — vilket är
          just det fall ingen hade upptäckt. */}
      {saknarKonto && (
        <p
          className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[12.5px] text-amber-700"
          data-testid="pdf-malbesked"
        >
          Den här tolkningen bär inget målkonto. Avbryt och ladda upp PDF:en igen från Importera
          kontoutdrag, där du väljer vilket bankkonto utdraget gäller.
        </p>
      )}
      {!saknarKonto && utfall?.besked && (
        <div
          className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[12.5px] text-amber-700"
          role="alert"
          data-testid="pdf-malbesked"
        >
          <p>{utfall.besked}</p>
          {utfall.kräverNyttVal && (
            <p className="mt-1">
              Avbryt och ladda upp PDF:en igen från Importera kontoutdrag, där du väljer ett konto
              som går att importera till.
            </p>
          )}
          {utfall.kanHämtasOm && (
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              onClick={() => void hämtaKontonIgen()}
              data-testid="pdf-hamta-konton-igen"
            >
              Försök igen
            </Button>
          )}
        </div>
      )}

      <ModalFooter>
        <Button variant="ghost" onClick={handleCancel} loading={cancelMut.isPending}>
          Avbryt
        </Button>
        <Button
          variant="primary"
          onClick={handleConfirm}
          loading={confirmMut.isPending}
          disabled={incomingActive.length === 0 || målSpärrat}
        >
          <CheckCircle2 size={14} /> Bekräfta & matcha {incomingActive.length} inbetalningar
        </Button>
      </ModalFooter>
    </Modal>
  )
}
