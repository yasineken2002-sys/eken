import { useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, CircleAlert, FileMinus, FilePlus2, Info } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { extractApiError } from '@/lib/api'
import { useAuthStore } from '@/stores/auth.store'
import { usePeriodHistory, useReopenPeriod } from '../hooks/useAccounting'
import { PeriodHistoryChain } from './PeriodHistoryChain'
import { periodLabel } from './period-label'
import type { PeriodReasonCategory } from '../api/accounting.api'

interface Props {
  period: { year: number; month: number }
  onClose: () => void
}

const MIN_REASON = 10

/**
 * Öppna en stängd bokföringsperiod igen.
 *
 * Dialogen är byggd kring EN fråga — vad användaren faktiskt försöker göra —
 * eftersom svaret avgör om återöppning över huvud taget är rätt verktyg. En post
 * som SAKNAS hör hemma i sin period. En post som är FEL rättas i innevarande
 * period och aldrig genom att öppna den gamla månaden.
 *
 * Alla spärrar nedan finns också server-side (`AccountingPeriodService.reopenPeriod`)
 * — det här lagret finns för att användaren inte ska behöva trycka på en knapp för
 * att få veta att den är låst. UNDANTAGET är moms-kryssrutan, som är en ren
 * läsbekräftelse i UI:t och inte grindas av servern; den finns för att varningen
 * ska bli läst, inte för att garantera något.
 */
export function ReopenPeriodModal({ period, onClose }: Props) {
  const detail = usePeriodHistory(period)
  const reopen = useReopenPeriod()
  const role = useAuthStore((s) => s.user?.role)
  const isOwner = role === 'OWNER'

  const [category, setCategory] = useState<PeriodReasonCategory | null>(null)
  const [reason, setReason] = useState('')
  const [vatAck, setVatAck] = useState(false)

  const d = detail.data
  const vatPeriods = d?.vatPeriods ?? []
  const needsVatAck = vatPeriods.length > 0 && !vatAck
  const reasonOk = reason.trim().length >= MIN_REASON
  const canSubmit =
    isOwner &&
    d?.withinReopenWindow === true &&
    category === 'MISSING_ENTRY' &&
    reasonOk &&
    !needsVatAck &&
    !reopen.isPending

  function handleReopen() {
    if (!category) return
    reopen.mutate(
      { year: period.year, month: period.month, reason: reason.trim(), reasonCategory: category },
      {
        onSuccess: () => {
          toast.success(`${periodLabel(period)} är öppen igen.`)
          onClose()
        },
        onError: (err: unknown) =>
          toast.error(extractApiError(err, 'Perioden kunde inte öppnas igen.')),
      },
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${periodLabel(period)}`}
      description="Periodens historik och möjlighet att öppna den igen."
    >
      {detail.isLoading ? (
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-xl bg-gray-100" />
          ))}
        </div>
      ) : !d ? (
        <p className="text-[13px] text-gray-600">Kunde inte ladda perioden. Försök igen.</p>
      ) : (
        <div className="space-y-5">
          {/* Historiken först — den svarar på "vad har hänt här?" */}
          <section>
            <h3 className="mb-2.5 text-[14px] font-semibold text-gray-900">Historik</h3>
            <PeriodHistoryChain events={d.events} />
          </section>

          {!d.closed ? (
            <p className="rounded-xl bg-gray-50 p-3 text-[13px] text-gray-600">
              Perioden är öppen. Du kan bokföra i den som vanligt.
            </p>
          ) : !d.withinReopenWindow ? (
            /* Räkenskapsårsspärren — hård, ingen kryssruta, inget val. */
            <section className="flex gap-2 rounded-xl bg-red-50 p-3">
              <CircleAlert size={15} strokeWidth={1.8} className="mt-0.5 shrink-0 text-red-600" />
              <div className="space-y-2 text-[13px] text-red-700">
                <p className="font-medium">
                  Räkenskapsåret {d.fiscalYear} avslutades {d.fiscalYearEnd} och kan inte öppnas
                  igen.
                </p>
                <p>
                  Fel som upptäcks efter att ett räkenskapsår avslutats rättas i innevarande period,
                  med en notering om vilket år felet gäller. Det är den ordning som gäller oavsett
                  system — stäm av med din redovisningskonsult.
                </p>
              </div>
            </section>
          ) : !isOwner ? (
            <p className="rounded-xl bg-gray-50 p-3 text-[13px] text-gray-600">
              Bara kontoägaren kan öppna en stängd period igen. Behöver du det gjort — be den som
              äger kontot, och förklara varför.
            </p>
          ) : (
            <>
              <section>
                <h3 className="mb-2.5 text-[14px] font-semibold text-gray-900">
                  Vad behöver du göra?
                </h3>
                <div className="space-y-2">
                  <CategoryOption
                    icon={FilePlus2}
                    selected={category === 'MISSING_ENTRY'}
                    title="En post saknas i perioden"
                    description="En hyresavi, ett kvitto eller en betalning som aldrig blev bokförd."
                    onSelect={() => setCategory('MISSING_ENTRY')}
                  />
                  <CategoryOption
                    icon={FileMinus}
                    selected={category === 'EXISTING_ENTRY_INCORRECT'}
                    title="En bokförd post är felaktig"
                    description="Fel belopp, fel konto, eller en post som inte borde finnas."
                    onSelect={() => setCategory('EXISTING_ENTRY_INCORRECT')}
                  />
                </div>
              </section>

              {/* Den pedagogiskt bärande texten. Nekar inte bara — förklarar. */}
              {category === 'EXISTING_ENTRY_INCORRECT' && (
                <section className="space-y-2.5 rounded-xl bg-amber-50 p-3.5 text-[13px] text-amber-900">
                  <p className="font-semibold">Perioden behöver inte öppnas för det här.</p>
                  <p>
                    En bokförd post ändras aldrig i efterhand — inte i någon månad, hur ny den än
                    är. Ett fel rättas i stället genom att du bokför en ny post idag som tar ut den
                    felaktiga, och en ny korrekt post bredvid.
                  </p>
                  <p>
                    Den felaktiga posten står kvar precis som den var. Det är själva poängen: det
                    ska gå att se vad som faktiskt bokfördes, när felet upptäcktes och hur det
                    rättades. Öppnade vi {periodLabel(period)} och ändrade där skulle det se ut som
                    att posten alltid varit rätt.
                  </p>
                  <p>
                    Så här gör du: öppna <span className="font-medium">Verifikationer</span>, klicka
                    på den felaktiga posten och välj{' '}
                    <span className="font-medium">Rätta verifikatet</span>. Systemet bokför
                    motsatsen åt dig — du behöver inte välja konton själv. Behöver du därefter
                    bokföra rätt belopp gör du det på vanligt sätt, eller ber din
                    redovisningskonsult.
                  </p>
                </section>
              )}

              {category === 'MISSING_ENTRY' && (
                <>
                  {vatPeriods.length > 0 && (
                    <section className="flex gap-2 rounded-xl bg-amber-50 p-3">
                      <AlertTriangle
                        size={15}
                        strokeWidth={1.8}
                        className="mt-0.5 shrink-0 text-amber-600"
                      />
                      <div className="space-y-2 text-[13px] text-amber-900">
                        <p>
                          Perioden ingår i momsperioden {vatPeriods.join(', ')}. Så lång tid har
                          gått att den sannolikt redan är deklarerad till Skatteverket — men det vet
                          inte systemet med säkerhet. Om ändringen du gör påverkar momsbeloppet kan
                          en redan inlämnad deklaration behöva rättas separat. Stäm av med din
                          redovisningskonsult innan du fortsätter.
                        </p>
                        <label className="flex cursor-pointer items-start gap-2">
                          <input
                            type="checkbox"
                            checked={vatAck}
                            onChange={(e) => setVatAck(e.target.checked)}
                            className="mt-0.5 h-3.5 w-3.5 rounded border-gray-300"
                          />
                          <span className="text-[12px] font-medium">
                            Jag har läst varningen om momsperioden.
                          </span>
                        </label>
                      </div>
                    </section>
                  )}

                  <section>
                    <label
                      htmlFor="reopen-reason"
                      className="mb-1.5 block text-[13px] font-medium text-gray-700"
                    >
                      Varför öppnas perioden igen?
                    </label>
                    <textarea
                      id="reopen-reason"
                      rows={3}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="T.ex. Hyresavin för lgh 12 saknades helt — upptäckt vid avstämning"
                      className="w-full rounded-lg border border-gray-200 p-2.5 text-[13.5px] transition-all duration-150 hover:border-gray-300 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/15"
                    />
                    <p className="mt-1.5 flex items-start gap-1.5 text-[12px] text-gray-500">
                      <Info size={13} strokeWidth={1.8} className="mt-px shrink-0" />
                      Skälet sparas i periodens historik och går inte att ändra i efterhand. Minst{' '}
                      {MIN_REASON} tecken.
                    </p>
                  </section>
                </>
              )}
            </>
          )}
        </div>
      )}

      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>
          {category === 'EXISTING_ENTRY_INCORRECT' ? 'Jag förstår' : 'Avbryt'}
        </Button>
        {d?.closed && isOwner && d.withinReopenWindow && category === 'MISSING_ENTRY' && (
          <Button variant="primary" disabled={!canSubmit} onClick={handleReopen}>
            {reopen.isPending ? 'Öppnar…' : 'Öppna perioden igen'}
          </Button>
        )}
      </ModalFooter>
    </Modal>
  )
}

interface CategoryOptionProps {
  icon: typeof FilePlus2
  selected: boolean
  title: string
  description: string
  onSelect: () => void
}

function CategoryOption({
  icon: Icon,
  selected,
  title,
  description,
  onSelect,
}: CategoryOptionProps) {
  return (
    <button
      type="button"
      // Växlingsknapp i en exklusiv grupp — aria-pressed är ärligare än att
      // fejka radiogrupps-semantik med role="radio" utan pilnavigering.
      aria-pressed={selected}
      onClick={onSelect}
      className={`flex w-full gap-2.5 rounded-xl border p-3 text-left transition-colors ${
        selected ? 'border-blue-500 bg-blue-50/60' : 'border-line bg-white hover:bg-gray-50'
      }`}
    >
      <Icon
        size={16}
        strokeWidth={1.8}
        className={`mt-0.5 shrink-0 ${selected ? 'text-blue-600' : 'text-gray-400'}`}
      />
      <span>
        <span className="block text-[13.5px] font-medium text-gray-900">{title}</span>
        <span className="mt-0.5 block text-[12px] text-gray-500">{description}</span>
      </span>
    </button>
  )
}
