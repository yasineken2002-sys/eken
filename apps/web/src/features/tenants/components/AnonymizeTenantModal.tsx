import React, { useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { useAnonymizeTenant } from '../hooks/useTenants'

interface AnonymizeTenantModalProps {
  open: boolean
  onClose: () => void
  tenantId: string
  tenantName: string
}

/**
 * Verkställ en raderingsbegäran (GDPR Art. 17) å hyresgästens vägnar.
 *
 * Bekräftelsen kräver att namnet skrivs av. Det är inte pynt: åtgärden går inte
 * att ångra — personuppgifterna skrivs över, och det finns ingen kopia att
 * återställa ifrån.
 */
export function AnonymizeTenantModal({
  open,
  onClose,
  tenantId,
  tenantName,
}: AnonymizeTenantModalProps) {
  const [confirmation, setConfirmation] = useState('')
  const [reason, setReason] = useState('')
  const mutation = useAnonymizeTenant()

  const confirmed = confirmation.trim() === tenantName.trim()

  function handleClose() {
    setConfirmation('')
    setReason('')
    mutation.reset()
    onClose()
  }

  function handleSubmit() {
    mutation.mutate(
      { id: tenantId, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      { onSuccess: handleClose },
    )
  }

  return (
    <Modal open={open} onClose={handleClose} title="Avidentifiera hyresgäst">
      <div className="space-y-5">
        <div className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" strokeWidth={1.8} />
          <div className="space-y-2 text-[13px] text-amber-900">
            <p className="font-medium">Åtgärden går inte att ångra.</p>
            <p>
              Namn, personnummer, kontaktuppgifter och portalinloggning tas bort permanent.
              Hyresgästen loggas ut direkt.
            </p>
            <p>
              Avtal, avier, fakturor och verifikat <strong>bevaras</strong> — underlaget måste
              finnas kvar enligt bokföringslagen. De kopplas till en avidentifierad post.
            </p>
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-gray-700">
            Anledning <span className="font-normal text-gray-400">(valfritt)</span>
          </label>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="T.ex. ärendenummer för raderingsbegäran"
            maxLength={500}
          />
          <p className="mt-1.5 text-[12px] text-gray-500">
            Sparas i revisionsspåret tillsammans med vem som utförde åtgärden och när.
          </p>
        </div>

        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-gray-700">
            Skriv <span className="font-semibold text-gray-900">{tenantName}</span> för att bekräfta
          </label>
          <Input
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            placeholder={tenantName}
            autoComplete="off"
          />
        </div>

        {mutation.isError && (
          <p className="text-[13px] text-red-600">
            {mutation.error instanceof Error
              ? mutation.error.message
              : 'Avidentifieringen misslyckades'}
          </p>
        )}

        <div className="border-line mt-5 flex justify-end gap-2 border-t pt-5">
          <Button variant="secondary" onClick={handleClose} disabled={mutation.isPending}>
            Avbryt
          </Button>
          <Button
            variant="danger"
            onClick={handleSubmit}
            disabled={!confirmed || mutation.isPending}
          >
            {mutation.isPending ? 'Avidentifierar…' : 'Avidentifiera'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
