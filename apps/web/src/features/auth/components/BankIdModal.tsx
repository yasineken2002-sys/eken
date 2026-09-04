import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { AlertCircle, Smartphone } from 'lucide-react'
import { BankIdQr } from './BankIdQr'
import { hintText, type BankIdFlowState } from '../lib/bankid-flow'
import type { BankIdAccount } from '../api/bankid.api'

const ROLLNAMN: Record<string, string> = {
  OWNER: 'Ägare',
  ADMIN: 'Administratör',
  MANAGER: 'Förvaltare',
  ACCOUNTANT: 'Ekonomi',
  VIEWER: 'Läsbehörighet',
}

interface BankIdModalProps {
  open: boolean
  onClose: () => void
  state: BankIdFlowState
  /** Rubrik — flödet är detsamma för inloggning och anslutning, texten inte. */
  title: string
  description: string
  onRetry: () => void
  /** Bara inloggningsflödet har ett kontoval. */
  onChooseAccount?: (userId: string) => void
  valjerKonto?: boolean
}

/**
 * Modalen för BÅDA BankID-flödena — inloggning och anslutning.
 *
 * Formen är gemensam därför att flödet är det: starta, visa QR eller
 * autostartknapp, vänta, och sluta i ett av tre utfall. Rubrik och beskrivning
 * skiljer sig, och kontovalet finns bara vid inloggning. Två nästan lika modaler
 * hade glidit isär i hjälptexter och feltexter — och det är just texterna som
 * ska vara desamma.
 *
 * TILLSTÅNDET KOMMER UTIFRÅN. Komponenten fattar inga beslut; den renderar det
 * `bankid-flow.ts` räknat ut. Det är därför flödets alla grenar går att pröva
 * utan att rendera något (se vitest.config.ts — webs prov kör i node).
 */
export function BankIdModal({
  open,
  onClose,
  state,
  title,
  description,
  onRetry,
  onChooseAccount,
  valjerKonto = false,
}: BankIdModalProps) {
  return (
    <Modal open={open} onClose={onClose} title={title} description={description} size="sm">
      <div className="min-h-[280px] py-2" data-testid="bankid-modal">
        {state.steg === 'startar' && (
          <p className="text-ink-muted py-16 text-center text-[13px]">Startar BankID…</p>
        )}

        {state.steg === 'pollar' && (
          <div className="flex flex-col items-center gap-4">
            {state.qrData ? (
              <BankIdQr value={state.qrData} />
            ) : (
              <div className="border-line bg-canvas flex h-[208px] w-[208px] items-center justify-center rounded-xl border">
                <p className="text-ink-muted px-4 text-center text-[12px]">
                  Ingen QR-kod från BankID. Använd knappen nedan på den här enheten.
                </p>
              </div>
            )}

            <p className="text-ink text-[13px] font-medium">{hintText(state.hintCode)}</p>

            {state.autoStartToken && (
              <a
                href={`bankid:///?autostarttoken=${state.autoStartToken}&redirect=null`}
                className="border-line bg-surface text-ink hover:bg-canvas inline-flex h-9 items-center gap-1.5 rounded-[10px] border px-4 text-[13.5px] font-medium transition-all duration-150"
              >
                <Smartphone size={14} strokeWidth={1.8} />
                Öppna BankID på den här enheten
              </a>
            )}
          </div>
        )}

        {state.steg === 'val' && (
          <div className="space-y-2">
            <p className="text-ink-muted text-[13px]">
              Ditt BankID är kopplat till flera konton. Välj vilket du vill logga in på.
            </p>
            {state.accounts.map((konto: BankIdAccount) => (
              <button
                key={konto.userId}
                type="button"
                disabled={valjerKonto}
                onClick={() => onChooseAccount?.(konto.userId)}
                className="border-line bg-surface hover:bg-canvas flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left transition-colors disabled:opacity-60"
              >
                <span className="text-ink text-[13.5px] font-medium">{konto.organizationName}</span>
                <Badge variant="default">{ROLLNAMN[konto.role] ?? konto.role}</Badge>
              </button>
            ))}
          </div>
        )}

        {state.steg === 'fel' && (
          <div className="flex flex-col items-center gap-4 py-10">
            <AlertCircle size={24} strokeWidth={1.8} className="text-danger" />
            <p className="text-ink text-center text-[13.5px]" data-testid="bankid-error">
              {state.meddelande}
            </p>
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Försök igen
            </Button>
          </div>
        )}
      </div>
    </Modal>
  )
}
