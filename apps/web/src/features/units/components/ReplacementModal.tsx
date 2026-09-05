import React, { useState } from 'react'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { useRegisterReplacement } from '../hooks/useEquipment'
import { EQUIPMENT_KINDS, EQUIPMENT_KIND_LABELS } from '../api/equipment.api'
import { validateReplacement, toReplacementPayload, TOMT_BYTE } from './equipment-form'
import type { Fel, ReplacementFormValues } from './equipment-form'
import type { Equipment } from '../api/equipment.api'

interface Props {
  equipment: Equipment | null
  unitId: string
  onClose: () => void
}

/**
 * ETT BYTE ÄR EN HÄNDELSE, INTE EN REDIGERING — och formuläret säger det.
 *
 * Den gamla saken ändras inte; den får ett slutdatum och en efterträdare, och
 * båda skrivs i samma transaktion som händelsen. Därför "Registrera byte" och
 * inte "Redigera".
 */
export function ReplacementModal({ equipment, unitId, onClose }: Props) {
  const [värden, setVärden] = useState<ReplacementFormValues>(TOMT_BYTE)
  const [fel, setFel] = useState<Fel>({})
  const registrera = useRegisterReplacement(unitId)

  const sätt = (fält: keyof ReplacementFormValues) => (v: string) =>
    setVärden((f) => ({ ...f, [fält]: v }))

  const stäng = () => {
    setVärden(TOMT_BYTE)
    setFel({})
    onClose()
  }

  const spara = () => {
    if (!equipment) return
    const f = validateReplacement(värden)
    setFel(f)
    if (Object.keys(f).length > 0) return
    registrera.mutate({ id: equipment.id, ...toReplacementPayload(värden) }, { onSuccess: stäng })
  }

  const nuvarande = equipment
    ? equipment.label
      ? `${EQUIPMENT_KIND_LABELS[equipment.kind]} — ${equipment.label}`
      : EQUIPMENT_KIND_LABELS[equipment.kind]
    : ''

  return (
    <Modal
      open={equipment !== null}
      onClose={stäng}
      title="Registrera byte"
      description={`${nuvarande} markeras som utbytt och efterträdaren läggs till. Bytet går inte att ändra efteråt — en felregistrering rättas med en ny händelse.`}
    >
      <div className="space-y-4">
        <Input
          label="När byttes den"
          type="date"
          value={värden.occurredAt}
          onChange={(e) => sätt('occurredAt')(e.target.value)}
          {...(fel.occurredAt ? { error: fel.occurredAt } : {})}
        />

        <Select
          label="Sort på den nya"
          value={värden.kind}
          onChange={(e) => sätt('kind')(e.target.value)}
          options={[
            // Tomt = ärv föregångarens sort. Servern gör ärvningen, inte klienten.
            { value: '', label: 'Samma sort som tidigare' },
            ...EQUIPMENT_KINDS.map((k) => ({ value: k, label: EQUIPMENT_KIND_LABELS[k] })),
          ]}
        />

        <Input
          label="Beteckning på den nya"
          placeholder="t.ex. Kyl 2026"
          value={värden.label}
          onChange={(e) => sätt('label')(e.target.value)}
        />

        <Input
          label="Kostnad (kr)"
          hint="Lämna tomt om kostnaden är okänd. Tomt betyder okänt, inte noll."
          value={värden.cost}
          onChange={(e) => sätt('cost')(e.target.value)}
          {...(fel.cost ? { error: fel.cost } : {})}
        />

        <Input
          label="Anteckning"
          placeholder="t.ex. Kompressorn dog"
          value={värden.note}
          onChange={(e) => sätt('note')(e.target.value)}
        />

        <ModalFooter>
          <Button variant="secondary" onClick={stäng}>
            Avbryt
          </Button>
          <Button variant="primary" onClick={spara} disabled={registrera.isPending}>
            {registrera.isPending ? 'Registrerar…' : 'Registrera byte'}
          </Button>
        </ModalFooter>
      </div>
    </Modal>
  )
}
