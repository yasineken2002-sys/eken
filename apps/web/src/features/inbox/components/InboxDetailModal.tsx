import React, { useState } from 'react'

import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@eken/ui/react'
import { formatDate } from '@eken/shared'

import { formatKonfidens, konfidensVariant } from '../lib/confidence'
import { GorAlltidSaHar } from './GorAlltidSaHar'

import type { InboxItem, KanDelegera } from '../api/inbox.api'

interface Props {
  item: InboxItem | null
  onClose: () => void
  onDecide: (params: { id: string; decision: 'APPROVED' | 'REJECTED'; reason?: string }) => void
  pending?: boolean
  /** "Gör alltid så här" — utelämnas i prov som bara mäter beslutsflödet. */
  kanDelegera?: KanDelegera | undefined
  delegeringLaddar?: boolean
  delegeringSparar?: boolean
  onDelegera?: (villkor: Record<string, unknown> | undefined) => void
}

/** Ett fält i planens ordning. Rubriken är frågan, inte fältnamnet. */
function Falt({ rubrik, children }: { rubrik: string; children: React.ReactNode }) {
  return (
    <div className="border-line border-b pb-3 last:border-0">
      <div className="text-[12px] font-medium text-gray-500">{rubrik}</div>
      <div className="mt-1 text-[13.5px] text-gray-900">{children}</div>
    </div>
  )
}

/**
 * DETALJEN — planens fem frågor, i planens ordning.
 *
 * `docs/eveno-agentplan.md` (Del 14): hyresvärden ska se *"vad hade agenten
 * gjort · varför · vilken information den använde · hur säker den var · vad som
 * hade krävt godkännande"*. Ordningen är inte kosmetisk: den går från handling
 * till motivering till underlag, vilket är den ordning man behöver för att kunna
 * säga emot.
 */
export function InboxDetailModal({
  item,
  onClose,
  onDecide,
  pending,
  kanDelegera,
  delegeringLaddar,
  delegeringSparar,
  onDelegera,
}: Props) {
  const [bekraftar, setBekraftar] = useState<'APPROVED' | 'REJECTED' | null>(null)
  const [skal, setSkal] = useState('')

  if (!item) return null

  const stang = () => {
    setBekraftar(null)
    setSkal('')
    onClose()
  }

  const beslutat = item.status !== 'AWAITING_APPROVAL'

  return (
    <Modal open={Boolean(item)} onClose={stang} title={item.title} description={item.consequence}>
      <div className="space-y-3">
        <Falt rubrik="Vad agenten hade gjort">
          <span className="font-mono text-[13px]">{item.toolName}</span>
          {Object.keys(item.toolInput ?? {}).length > 0 && (
            <pre className="mt-1 overflow-x-auto rounded-lg bg-gray-50 p-2 text-[12px] text-gray-700">
              {JSON.stringify(item.toolInput, null, 2)}
            </pre>
          )}
        </Falt>

        <Falt rubrik="Varför">{item.reasoning}</Falt>

        <Falt rubrik="Vilken information den använde">
          {item.evidence?.length ? (
            <ul className="space-y-1">
              {item.evidence.map((e) => (
                <li key={`${e.entityType}-${e.entityId}`} className="text-[13px]">
                  {e.label}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-gray-500">Ingen kontext registrerad.</span>
          )}
        </Falt>

        <Falt rubrik="Hur säker den var">
          <Badge variant={konfidensVariant(item.confidence)}>
            {formatKonfidens(item.confidence)}
          </Badge>
        </Falt>

        <Falt rubrik="Vad som hade krävt godkännande">
          {/* SKUGGLÄGETS SANNING, UTSKRIVEN. Planen säger att ett godkännande
              grindar skrivningen; i den här etappen utförs ingenting ens vid
              godkännande, eftersom utföraren inte finns. Står det inte här
              godkänner hyresvärden något i tron att det händer — och den
              missuppfattningen är värre än ett dåligt förslag. */}
          <span>{item.consequence}</span>
          <div className="mt-1 text-[12px] text-gray-500">
            Ångerväg om det utförts: {item.undoHint}
          </div>
        </Falt>

        {item.statusReason && <Falt rubrik="Ditt skäl">{item.statusReason}</Falt>}
        <Falt rubrik="Skapat">{formatDate(item.createdAt)}</Falt>
      </div>

      {onDelegera && (
        <GorAlltidSaHar
          status={item.status}
          kan={kanDelegera}
          toolName={item.toolName}
          laddar={delegeringLaddar}
          sparar={delegeringSparar}
          onSkapa={onDelegera}
        />
      )}

      {!beslutat && bekraftar === null && (
        <ModalFooter>
          <Button variant="secondary" onClick={() => setBekraftar('REJECTED')}>
            Avvisa
          </Button>
          <Button variant="primary" onClick={() => setBekraftar('APPROVED')}>
            Godkänn
          </Button>
        </ModalFooter>
      )}

      {bekraftar !== null && (
        <div className="border-line mt-5 border-t pt-4">
          <p className="text-[13px] text-gray-700">
            {bekraftar === 'APPROVED'
              ? 'Du godkänner att förslaget var rätt. Ingenting utförs — i skuggläge är beslutet ett facit, inte en åtgärd.'
              : 'Du avvisar förslaget. Ingenting utförs — i skuggläge är beslutet ett facit, inte en åtgärd.'}
          </p>
          {bekraftar === 'REJECTED' && (
            <label className="mt-3 block">
              <span className="text-[13px] font-medium text-gray-700">Varför? (valfritt)</span>
              <textarea
                className="mt-1 h-20 w-full rounded-xl border border-gray-200 bg-white px-3.5 py-2 text-[13.5px] text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/15"
                maxLength={500}
                value={skal}
                placeholder="Skälet är minnesmat för agenten."
                onChange={(e) => setSkal(e.target.value)}
              />
              <span className="text-[12px] text-gray-400">{skal.length}/500</span>
            </label>
          )}
          <ModalFooter>
            <Button variant="ghost" onClick={() => setBekraftar(null)}>
              Tillbaka
            </Button>
            <Button
              variant={bekraftar === 'APPROVED' ? 'primary' : 'danger'}
              disabled={pending}
              onClick={() =>
                onDecide({
                  id: item.id,
                  decision: bekraftar,
                  ...(bekraftar === 'REJECTED' && skal.trim() ? { reason: skal.trim() } : {}),
                })
              }
            >
              {bekraftar === 'APPROVED' ? 'Ja, förslaget var rätt' : 'Ja, avvisa'}
            </Button>
          </ModalFooter>
        </div>
      )}
    </Modal>
  )
}
