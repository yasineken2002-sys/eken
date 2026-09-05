import { FileSignature } from 'lucide-react'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'

/**
 * SKICKA FÖR SIGNERING — människans väg till `prepare_contract_signing`.
 *
 * Verktyget stod i baslinjen med skälet att `POST /v1/signing/requests` finns
 * men att ingen rad i apps/web anropar den: ContractTab VISADE signeringens
 * status medan begäran i dag bara startades av portalaktiveringen eller av
 * AI-verktyget.
 *
 * ── PROVIDERN SKA SYNAS, INTE GISSAS ────────────────────────────────────────
 *
 * Signeringsmodulen är inert i produktion tills S3: `SIGNING_ENABLED=false` ger
 * en stub som kastar 503. En knapp som ser normal ut och tyst inte gör något är
 * det sämsta utfallet — hyresvärden tror att kontraktet är på väg.
 *
 * Felet visas därför i klartext, med serverns eget meddelande. Det är samma
 * riktning som `prepare_contract_signing` självt har: verktyget returnerar
 * `success: false` med kastets text i stället för att påstå att något
 * förbereddes.
 *
 * ── VAD KNAPPEN INTE GÖR ────────────────────────────────────────────────────
 *
 * Den FÖRBEREDER en begäran. Signeringen slutförs av en människa med BankID i
 * signeringsvyn — AI-verktygets egen text säger det, och bekräftelsen upprepar
 * det, så att ingen tror att kontraktet är signerat när det är skickat.
 */

interface Props {
  open: boolean
  onClose: () => void
  dokumentnamn: string
  mottagare: string
  onBekrafta: () => void
  arbetar: boolean
  fel: string | null
}

export function SendForSigningModal({
  open,
  onClose,
  dokumentnamn,
  mottagare,
  onBekrafta,
  arbetar,
  fel,
}: Props) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Skicka för signering"
      description="En signeringsbegäran förbereds för kontraktet."
    >
      <div className="space-y-4">
        <dl
          className="border-line space-y-2.5 rounded-2xl border p-4"
          data-testid="signing-summary"
        >
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-[12px] text-gray-400">Dokument</dt>
            <dd className="text-right text-[13px] font-medium text-gray-900">{dokumentnamn}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-[12px] text-gray-400">Mottagare</dt>
            <dd className="text-right text-[13px] text-gray-900">{mottagare}</dd>
          </div>
        </dl>

        <p className="border-line rounded-xl border bg-gray-50/60 px-4 py-3 text-[12px] text-gray-500">
          Begäran förbereds — kontraktet är inte signerat förrän hyresgästen slutfört signeringen
          med BankID. Du ser statusen här när den ändras.
        </p>

        {fel && (
          <p
            className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] text-red-600"
            data-testid="signing-error"
          >
            {fel}
          </p>
        )}
      </div>

      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>
          Avbryt
        </Button>
        <Button
          variant="primary"
          onClick={onBekrafta}
          disabled={arbetar}
          data-testid="signing-confirm"
        >
          <FileSignature size={14} strokeWidth={1.8} />
          {arbetar ? 'Förbereder…' : 'Skicka för signering'}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
