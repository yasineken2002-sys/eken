import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { extractApiError } from '@/lib/api'
import {
  reconcileFortnoxExport,
  releaseRejectedFortnoxExport,
  sendFortnoxExport,
  verifyFortnoxExport,
  type FortnoxExportRow,
} from '../api/fortnox-export.api'
import {
  EXPORT_NEXT_STEP,
  EXPORT_STATE_TEXT,
  REJECTION_TEXT,
  rejectionKind,
} from './fortnox-export-text'

const RECONCILABLE = new Set<FortnoxExportRow['state']>(['UNKNOWN', 'REJECTED', 'RECEIPT_MISMATCH'])

/**
 * TESTKUND-016 K1.6: när exporttexten skiljer sig från Evenos text visas båda. Evenos verifikat
 * skrivs aldrig om; bara texten som skickas till Fortnox mappas.
 */
export function FortnoxExportTextView({ items }: { items: FortnoxExportRow['exportText'] }) {
  return (
    <>
      {(items ?? []).map((t) => (
        <div
          key={`${t.falt}-${t.rad ?? 0}`}
          className="border-line bg-surface min-w-0 space-y-1 rounded-md border p-2 text-sm"
          data-export-text={t.falt}
        >
          <p className="text-ink break-words">
            Exporteras som: <span className="font-medium">{t.exporttext}</span>
          </p>
          <p className="text-ink-muted break-words">
            Originaltext{t.rad ? ` (rad ${t.rad})` : ''}: {t.originaltext}
          </p>
          <p className="text-ink-muted break-words text-xs">
            Fortnox tar inte emot tankstreck (—); det skickas som kort tankstreck (–). Evenos
            verifikat ändras inte.
          </p>
        </div>
      ))}
    </>
  )
}

/**
 * En exportrad: ärlig status, nästa tillåtna handling och — endast där kontraktet
 * tillåter — skicka (READY + aktiverad sändning), kontrollera (kvitto) eller
 * avstämning med exakt identitet. Ingen handling gör UNKNOWN omsändbart; en BEVISAT avvisad
 * export (Fortnox 4xx med kod, inte 429) kan frisläppas till en ny förhandskontroll (TESTKUND-016).
 */
export function FortnoxExportRowView({
  row,
  sendingEnabled,
  onChanged,
}: {
  row: FortnoxExportRow
  sendingEnabled: boolean
  onChanged: () => Promise<void>
}) {
  const [confirm, setConfirm] = useState(false)
  const [year, setYear] = useState('')
  const [series, setSeries] = useState('')
  const [number, setNumber] = useState('')
  const [reason, setReason] = useState('')
  const send = useMutation({
    mutationFn: () => sendFortnoxExport(row.id, { draftHash: row.draftHash ?? '', confirm: true }),
    retry: false,
    onSettled: onChanged,
  })
  const verify = useMutation({
    mutationFn: () => verifyFortnoxExport(row.id),
    retry: false,
    onSettled: onChanged,
  })
  const reconcile = useMutation({
    mutationFn: () =>
      reconcileFortnoxExport(row.id, { year: Number(year), series, number: Number(number) }),
    retry: false,
    onSettled: onChanged,
  })
  const release = useMutation({
    mutationFn: () => releaseRejectedFortnoxExport(row.id, { reason: reason.trim() }),
    retry: false,
    onSettled: onChanged,
  })
  const rejection = row.state === 'REJECTED' ? rejectionKind(row.lastOutcome) : null
  const identityOk =
    /^[1-9]\d{0,8}$/.test(year) &&
    /^[A-Za-z0-9]{1,10}$/.test(series) &&
    /^[1-9]\d{0,8}$/.test(number)
  const busy = send.isPending || verify.isPending || reconcile.isPending || release.isPending
  const error = send.error ?? verify.error ?? reconcile.error ?? release.error

  return (
    <li
      className="border-line min-w-0 space-y-2 rounded-lg border p-3"
      data-export-state={row.state}
    >
      <p className="text-ink break-words font-medium">{EXPORT_STATE_TEXT[row.state]}</p>
      {row.blockReason && <p className="text-ink-muted break-words">Skäl: {row.blockReason}</p>}
      <FortnoxExportTextView items={row.exportText} />
      {row.externalNumber != null && (
        <p className="text-ink-muted">
          Fortnox-verifikat {row.externalSeries}
          {row.externalNumber} (räkenskapsår-id {row.externalYear})
        </p>
      )}
      {EXPORT_NEXT_STEP[row.state] && (
        <p className="text-ink-muted break-words">{EXPORT_NEXT_STEP[row.state]}</p>
      )}

      {row.state === 'DRY_RUN_READY' && sendingEnabled && row.draftHash && (
        <div className="space-y-2">
          <label className="text-ink flex min-w-0 items-start gap-2">
            <input
              type="checkbox"
              className="mt-1 shrink-0"
              checked={confirm}
              onChange={(e) => setConfirm(e.target.checked)}
            />
            <span className="min-w-0 break-words">
              Jag vill skicka detta verifikat till Fortnox.
            </span>
          </label>
          <Button
            size="sm"
            variant="primary"
            disabled={!confirm || busy}
            onClick={() => send.mutate()}
          >
            {send.isPending ? 'Skickar…' : 'Skicka till Fortnox'}
          </Button>
        </div>
      )}

      {row.state === 'RECEIPT_IDENTIFIED' && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => verify.mutate()}>
          Kontrollera i Fortnox
        </Button>
      )}

      {rejection?.kind === 'CONTENT' && (
        <form
          aria-label="Frisläpp avvisad export"
          className="min-w-0 space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (reason.trim().length >= 5 && !busy) release.mutate()
          }}
        >
          <p className="text-ink-muted break-words text-sm">
            Fortnox avvisade innehållet (HTTP {rejection.http}, kod {rejection.code}). Om du har
            rättat orsaken kan exporten frisläppas för en ny förhandskontroll. Eveno läser först
            hela räkenskapsåret i Fortnox och vägrar om en post från detta verifikat redan finns.
          </p>
          <Input label="Skäl" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disabled={reason.trim().length < 5 || busy}
          >
            {release.isPending ? 'Kontrollerar i Fortnox…' : 'Frisläpp för ny förhandskontroll'}
          </Button>
        </form>
      )}
      {rejection && rejection.kind !== 'CONTENT' && (
        <p className="text-ink-muted break-words text-sm" data-rejection-kind={rejection.kind}>
          {REJECTION_TEXT[rejection.kind]}
        </p>
      )}

      {RECONCILABLE.has(row.state) && (
        <p className="text-ink-muted break-words text-sm">
          Gäller Evenos verifikat {row.journalEntryId.slice(0, 8)}. Ange identiteten för den post i
          Fortnox som motsvarar just detta verifikat.
        </p>
      )}
      {RECONCILABLE.has(row.state) && (
        <form
          aria-label="Avstämning mot Fortnox"
          className="grid min-w-0 gap-2 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (identityOk && !busy) reconcile.mutate()
          }}
        >
          <Input
            label="Räkenskapsår-id"
            inputMode="numeric"
            value={year}
            onChange={(e) => setYear(e.target.value.trim())}
          />
          <Input label="Serie" value={series} onChange={(e) => setSeries(e.target.value.trim())} />
          <Input
            label="Nummer"
            inputMode="numeric"
            value={number}
            onChange={(e) => setNumber(e.target.value.trim())}
          />
          <div className="flex items-end">
            <Button type="submit" size="sm" variant="secondary" disabled={!identityOk || busy}>
              Stäm av
            </Button>
          </div>
        </form>
      )}
      {error && <p className="break-words text-sm text-red-600">{extractApiError(error)}</p>}
    </li>
  )
}
