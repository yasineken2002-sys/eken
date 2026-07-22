import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { Receipt, BookCheck, Ban } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { MiscChargeBadge } from './MiscChargeBadge'
import {
  useMiscCharge,
  useCreateMiscCharge,
  useConfirmMiscCharge,
  useCancelMiscCharge,
} from '../hooks/useMiscCharges'
import { useCanWrite } from '@/hooks/useCanWrite'
import { formatCurrency, formatDate } from '@eken/shared'

// "Debitera hyresgäst & bokför" på ett felanmälningsärende (teknisk förvaltning,
// Spår A PR 4). Skapar en MiscCharge (DRAFT) och bokför den (CONFIRMED) i ETT
// flöde — speglar consumptions "Bekräfta och bokför". Frontend räknar ALDRIG om
// belopp; backend fryser momssnapshot och äger all kontering.

interface TicketRef {
  id: string
  ticketNumber: string
  // Sätts av backend när ärendet redan debiterats (MaintenanceTicket.chargeId).
  chargeId?: string | null | undefined
  // Härlett aktivt avtal + ärendets hyresgäst — krävs för att kunna debitera.
  leaseId?: string | null | undefined
  tenantId?: string | null | undefined
}

const schema = z.object({
  netAmount: z.coerce.number().positive('Beloppet måste vara större än noll'),
  description: z.string().min(1, 'Ange en beskrivning').max(500, 'Högst 500 tecken'),
  incidentDate: z.string().min(1, 'Ange ett datum'),
})
type FormValues = z.input<typeof schema>

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

export function DebitTenantCard({ ticket }: { ticket: TicketRef }) {
  const canWrite = useCanWrite()
  const [modalOpen, setModalOpen] = useState(false)

  const { data: charge, isLoading: chargeLoading } = useMiscCharge(ticket.chargeId)
  const createMutation = useCreateMiscCharge()
  const confirmMutation = useConfirmMiscCharge()
  const cancelMutation = useCancelMiscCharge()

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { incidentDate: todayIso() },
  })

  // ── Skapa + bokför i ett flöde ───────────────────────────────────────────
  // create kan kasta 409 (redan debiterat) / 404 (lease/tenant) → global toast.
  // confirm kan ge 200 (success-toast), 400 (CANCELLED), 404, 422 (saknat konto/
  // total≤0) — alla icke-200 visas av den globala MutationCache.onError med
  // backendens exakta meddelande, aldrig tyst. DRAFT:en kvarstår om confirm faller
  // och visas då i kortet med en "Bekräfta och bokför"-knapp för omförsök.
  const onSubmit = async (values: FormValues) => {
    if (!ticket.leaseId || !ticket.tenantId) return
    const created = await createMutation.mutateAsync({
      leaseId: ticket.leaseId,
      tenantId: ticket.tenantId,
      sourceType: 'MAINTENANCE_TICKET',
      sourceRefId: ticket.id,
      description: values.description,
      incidentDate: values.incidentDate,
      netAmount: Number(values.netAmount),
    })
    setModalOpen(false)
    reset({ incidentDate: todayIso() })
    try {
      await confirmMutation.mutateAsync(created.id)
      toast.success(`Debitering bokförd för ärende ${ticket.ticketNumber} (verifikat skapat)`)
    } catch {
      // Backendens felmeddelande visas redan av den globala onError. DRAFT:en
      // finns kvar och dyker upp i kortet för omförsök.
    }
  }

  function handleConfirmExisting() {
    if (!charge) return
    confirmMutation.mutate(charge.id, {
      onSuccess: () =>
        toast.success(`Debitering bokförd för ärende ${ticket.ticketNumber} (verifikat skapat)`),
    })
  }

  function handleCancel() {
    if (!charge) return
    // Cancel returnerar alltid status=CANCELLED vid 200 (DRAFT, CONFIRMED+motverifikat
    // eller idempotent no-op). Icke-200 visas av den globala MutationCache.onError.
    cancelMutation.mutate(charge.id, {
      onSuccess: () => toast.success('Debiteringen är annullerad'),
    })
  }

  // Charge-quern är in-flight (chargeId satt men ännu ej cachad) → visa en
  // platshållare istället för att låta "ej debiterat"-grenen blinka fram en aktiv
  // "Debitera"-knapp för ett ärende som redan är debiterat.
  if (ticket.chargeId && chargeLoading) {
    return <div className="border-line h-[68px] animate-pulse rounded-xl border bg-gray-50" />
  }

  // ── Redan debiterat: visa status + åtgärder ────────────────────────────────
  if (ticket.chargeId && charge) {
    const total = Number(charge.totalAmount)
    return (
      <div className="border-line rounded-xl border bg-white p-3.5">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            Debitering
          </p>
          <MiscChargeBadge status={charge.status} />
        </div>
        <p className="text-[13.5px] font-medium text-gray-800">{formatCurrency(total)}</p>
        <p className="mt-0.5 text-[12px] text-gray-500">
          {charge.description} · {formatDate(charge.incidentDate)}
        </p>

        {canWrite && charge.status === 'DRAFT' && (
          <div className="mt-3 flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-gray-400"
              loading={cancelMutation.isPending}
              onClick={handleCancel}
            >
              <Ban size={13} strokeWidth={1.9} />
              Annullera
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={confirmMutation.isPending}
              onClick={handleConfirmExisting}
            >
              <BookCheck size={13} strokeWidth={1.9} />
              Bekräfta och bokför
            </Button>
          </div>
        )}

        {canWrite && charge.status === 'CONFIRMED' && (
          <div className="mt-3 flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="text-gray-400"
              loading={cancelMutation.isPending}
              onClick={handleCancel}
            >
              <Ban size={13} strokeWidth={1.9} />
              Annullera (motverifikat)
            </Button>
          </div>
        )}
      </div>
    )
  }

  // ── Ej debiterat: knapp som öppnar skapa-och-bokför-modalen ────────────────
  if (!canWrite) return null

  const canDebit = !!ticket.leaseId && !!ticket.tenantId

  return (
    <div className="border-line rounded-xl border bg-white p-3.5">
      <p className="text-[13px] font-semibold text-gray-800">Debitera hyresgäst</p>
      <p className="mt-1 text-[12px] text-gray-500">
        Skapa en debiterbar post (skada/övrigt) och bokför den mot hyresgästen. Ett verifikat skapas
        (kundfordran 1510 + intäkt 3990).
      </p>
      {!canDebit && (
        <p className="mt-2 text-[12px] text-amber-700">
          Ärendet saknar aktivt avtal eller hyresgäst — kan inte debiteras.
        </p>
      )}
      <div className="mt-3 flex justify-end">
        <Button variant="primary" size="sm" disabled={!canDebit} onClick={() => setModalOpen(true)}>
          <Receipt size={13} strokeWidth={1.9} />
          Debitera & bokför
        </Button>
      </div>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={`Debitera hyresgäst — ${ticket.ticketNumber}`}
        size="md"
      >
        <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="space-y-4 px-6 pb-6">
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[12px] text-amber-700">
            Att bekräfta innebär att bokföra: ett verifikat skapas (kundfordran 1510 + intäkt 3990).
            Beloppet anges netto — moms hanteras av systemet. Åtgärden kan ångras via annullering
            (motverifikat).
          </div>

          <Input
            label="Belopp netto (kr) *"
            type="number"
            step="0.01"
            placeholder="0.00"
            error={errors.netAmount?.message}
            {...register('netAmount')}
          />

          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-gray-700">
              Beskrivning *
            </label>
            <textarea
              {...register('description')}
              rows={2}
              placeholder="T.ex. ersättning för krossad ruta"
              className="w-full rounded-lg border border-[#DDDFE4] px-3 py-2 text-[13.5px] text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {errors.description && (
              <p className="mt-1 text-[12px] text-red-500">{errors.description.message}</p>
            )}
          </div>

          <div>
            <label className="mb-1.5 block text-[13px] font-medium text-gray-700">
              Bokföringsdatum *
            </label>
            <input
              type="date"
              {...register('incidentDate')}
              className="h-9 w-full rounded-lg border border-[#DDDFE4] px-3 text-[13.5px] text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {errors.incidentDate && (
              <p className="mt-1 text-[12px] text-red-500">{errors.incidentDate.message}</p>
            )}
          </div>

          <div className="border-line flex justify-end gap-2 border-t pt-5">
            <Button variant="secondary" type="button" onClick={() => setModalOpen(false)}>
              Avbryt
            </Button>
            <Button
              variant="primary"
              type="submit"
              loading={createMutation.isPending || confirmMutation.isPending}
            >
              <BookCheck size={14} strokeWidth={1.9} />
              Debitera & bokför
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
