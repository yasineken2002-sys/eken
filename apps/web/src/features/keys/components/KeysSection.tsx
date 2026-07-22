import { useState } from 'react'
import { KeyRound, Plus, RotateCcw, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Badge, KeyStatusBadge, KeyTypeBadge } from '@/components/ui/Badge'
import { formatDate } from '@eken/shared'
import { useCanWrite } from '@/hooks/useCanWrite'
import { useKeys, useIssueKeys, useReturnKey, useUpdateKey } from '../hooks/useKeys'
import type { KeyHandoverDetail } from '../api/keys.api'
import type { KeyType } from '@eken/shared'

interface Props {
  leaseId: string
}

const KEY_TYPES: { value: KeyType; label: string }[] = [
  { value: 'APARTMENT', label: 'Lägenhetsnyckel' },
  { value: 'ENTRANCE', label: 'Portnyckel' },
  { value: 'MAILBOX', label: 'Postboxnyckel' },
  { value: 'LAUNDRY_TAG', label: 'Tvättstugebricka' },
  { value: 'GARAGE', label: 'Garagenyckel' },
  { value: 'STORAGE', label: 'Förrådsnyckel' },
  { value: 'FOB_TAG', label: 'Passerbricka/tagg' },
  { value: 'OTHER', label: 'Övrigt' },
]

export function KeysSection({ leaseId }: Props) {
  const { data: keys = [], isLoading } = useKeys({ leaseId })
  const canWrite = useCanWrite()
  const [showIssue, setShowIssue] = useState(false)

  const issued = keys.filter((k) => k.status === 'ISSUED').length
  const returned = keys.filter((k) => k.status === 'RETURNED').length
  const lost = keys.filter((k) => k.status === 'LOST').length

  if (isLoading) {
    return (
      <div className="rounded-xl border border-gray-100 p-4 text-[12.5px] text-gray-400">
        Laddar nycklar…
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-gray-100 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <KeyRound size={14} strokeWidth={1.8} className="text-gray-400" />
          <p className="text-[13px] font-semibold text-gray-800">Nycklar</p>
        </div>
        {/* Mjuk påminnelse — ingen blockering, bara en nudge. */}
        {issued > 0 && (
          <Badge variant="warning" dot>
            {issued} {issued === 1 ? 'nyckel' : 'nycklar'} ej återlämnade
          </Badge>
        )}
      </div>

      {keys.length > 0 ? (
        <>
          <p className="mb-3 text-[12px] text-gray-500">
            {issued} utlämnade · {returned} återlämnade
            {lost > 0 ? ` · ${lost} förlorade` : ''}
          </p>

          <ul className="divide-line border-line divide-y overflow-hidden rounded-lg border">
            {keys.map((k) => (
              <KeyRow key={k.id} keyItem={k} canWrite={canWrite} />
            ))}
          </ul>

          {canWrite && (
            <div className="mt-3">
              <Button size="sm" variant="secondary" onClick={() => setShowIssue(true)}>
                <Plus size={13} strokeWidth={1.8} />
                Lämna ut nyckel
              </Button>
            </div>
          )}
        </>
      ) : (
        <div className="space-y-2">
          <p className="text-[12.5px] text-gray-500">
            Inga nycklar är registrerade för det här kontraktet.
          </p>
          {canWrite && (
            <Button size="sm" variant="primary" onClick={() => setShowIssue(true)}>
              <Plus size={13} strokeWidth={1.8} />
              Lämna ut nyckel
            </Button>
          )}
        </div>
      )}

      <Modal open={showIssue} onClose={() => setShowIssue(false)} title="Lämna ut nyckel" size="sm">
        <IssueKeyForm leaseId={leaseId} onClose={() => setShowIssue(false)} />
      </Modal>
    </div>
  )
}

// ─── Rad ────────────────────────────────────────────────────────────────────────

function KeyRow({ keyItem, canWrite }: { keyItem: KeyHandoverDetail; canWrite: boolean }) {
  const returnMutation = useReturnKey()
  const updateMutation = useUpdateKey()

  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <KeyTypeBadge type={keyItem.type} />
          {keyItem.label && (
            <span className="text-[12.5px] font-medium text-gray-700">{keyItem.label}</span>
          )}
        </div>
        <p className="mt-0.5 text-[11.5px] text-gray-400">
          Utlämnad {formatDate(keyItem.issuedAt)}
          {keyItem.issuedToName ? ` · till ${keyItem.issuedToName}` : ''}
          {keyItem.returnedAt ? ` · återlämnad ${formatDate(keyItem.returnedAt)}` : ''}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <KeyStatusBadge status={keyItem.status} />
        {canWrite && keyItem.status === 'ISSUED' && (
          <>
            <Button
              size="xs"
              variant="secondary"
              loading={returnMutation.isPending}
              onClick={() => returnMutation.mutate({ id: keyItem.id })}
            >
              <RotateCcw size={11} strokeWidth={1.8} />
              Återlämna
            </Button>
            <button
              type="button"
              title="Markera förlorad"
              disabled={updateMutation.isPending}
              onClick={() => updateMutation.mutate({ id: keyItem.id, status: 'LOST' })}
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-[#DDDFE4] text-gray-400 hover:border-red-200 hover:text-red-500"
            >
              <AlertTriangle size={12} strokeWidth={1.8} />
            </button>
          </>
        )}
      </div>
    </li>
  )
}

// ─── Utlämningsformulär (bulk) ──────────────────────────────────────────────────

function IssueKeyForm({ leaseId, onClose }: { leaseId: string; onClose: () => void }) {
  const issueMutation = useIssueKeys()
  const [type, setType] = useState<KeyType>('APARTMENT')
  const [quantity, setQuantity] = useState('1')
  const [label, setLabel] = useState('')
  const [issuedToName, setIssuedToName] = useState('')
  const [notes, setNotes] = useState('')

  const qty = Number(quantity)
  const valid = qty >= 1 && qty <= 50

  const submit = () => {
    if (!valid) return
    issueMutation.mutate(
      {
        leaseId,
        type,
        quantity: qty,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(issuedToName.trim() ? { issuedToName: issuedToName.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      },
      { onSuccess: onClose },
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-gray-600">
        Varje nyckel registreras som en egen rad — ange antal för att lämna ut flera av samma typ på
        en gång.
      </p>

      <div className="space-y-1.5">
        <label className="block text-[13px] font-medium text-gray-700">Typ</label>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as KeyType)}
          className="h-9 w-full rounded-lg border border-[#DDDFE4] bg-white px-3 text-[13.5px] text-gray-800 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {KEY_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      <Input
        label="Antal"
        type="number"
        min={1}
        max={50}
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        error={valid ? undefined : 'Ange ett antal mellan 1 och 50'}
      />

      <Input
        label="Märkning (valfri)"
        placeholder="t.ex. Huvudnyckel / serienr 4471"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />

      <Input
        label="Utlämnad till (valfri, om annan än hyresgästen)"
        placeholder="t.ex. Sambo Anna"
        value={issuedToName}
        onChange={(e) => setIssuedToName(e.target.value)}
      />

      <Input label="Notering (valfri)" value={notes} onChange={(e) => setNotes(e.target.value)} />

      <ModalFooter>
        <Button variant="secondary" size="sm" onClick={onClose} disabled={issueMutation.isPending}>
          Avbryt
        </Button>
        <Button
          variant="primary"
          size="sm"
          loading={issueMutation.isPending}
          disabled={!valid}
          onClick={submit}
        >
          Lämna ut {valid && qty > 1 ? `${qty} st` : ''}
        </Button>
      </ModalFooter>
    </div>
  )
}
