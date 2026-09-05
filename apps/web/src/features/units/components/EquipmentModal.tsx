import React, { useState } from 'react'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { useCreateEquipment } from '../hooks/useEquipment'
import { EQUIPMENT_KINDS, EQUIPMENT_KIND_LABELS } from '../api/equipment.api'
import { validateEquipment, toCreatePayload, TOM_UTRUSTNING } from './equipment-form'
import type { Fel, EquipmentFormValues } from './equipment-form'

interface Props {
  open: boolean
  unitId: string
  onClose: () => void
}

export function EquipmentModal({ open, unitId, onClose }: Props) {
  const [värden, setVärden] = useState<EquipmentFormValues>(TOM_UTRUSTNING)
  const [fel, setFel] = useState<Fel>({})
  const skapa = useCreateEquipment(unitId)

  const sätt = (fält: keyof EquipmentFormValues) => (v: string) =>
    setVärden((f) => ({ ...f, [fält]: v }))

  const stäng = () => {
    setVärden(TOM_UTRUSTNING)
    setFel({})
    onClose()
  }

  const spara = () => {
    const f = validateEquipment(värden)
    setFel(f)
    if (Object.keys(f).length > 0) return
    skapa.mutate(toCreatePayload(unitId, värden), { onSuccess: stäng })
  }

  return (
    <Modal
      open={open}
      onClose={stäng}
      title="Lägg till utrustning"
      description="Registrera något som sitter i lägenheten. Installationsdatumet är NÄR-halvan av frågan historiken svarar på."
    >
      <div className="space-y-4">
        <Select
          label="Sort"
          value={värden.kind}
          onChange={(e) => sätt('kind')(e.target.value)}
          options={[
            { value: '', label: 'Välj sort…' },
            ...EQUIPMENT_KINDS.map((k) => ({ value: k, label: EQUIPMENT_KIND_LABELS[k] })),
          ]}
          {...(fel.kind ? { error: fel.kind } : {})}
        />

        <Input
          label="Beteckning"
          placeholder="t.ex. Kyl i köket"
          hint="Särskiljer när sorten inte räcker. Frivillig."
          value={värden.label}
          onChange={(e) => sätt('label')(e.target.value)}
        />

        <Input
          label="Installerad"
          type="date"
          value={värden.installedAt}
          onChange={(e) => sätt('installedAt')(e.target.value)}
          {...(fel.installedAt ? { error: fel.installedAt } : {})}
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Förväntad livslängd (år)"
            type="number"
            min={1}
            hint="Lämna tomt om ingen förväntan är uttalad."
            value={värden.expectedLifespanYears}
            onChange={(e) => sätt('expectedLifespanYears')(e.target.value)}
            {...(fel.expectedLifespanYears ? { error: fel.expectedLifespanYears } : {})}
          />
          <Input
            label="Serviceintervall (månader)"
            type="number"
            min={1}
            hint="Lämna tomt om ingen förväntan är uttalad."
            value={värden.serviceIntervalMonths}
            onChange={(e) => sätt('serviceIntervalMonths')(e.target.value)}
            {...(fel.serviceIntervalMonths ? { error: fel.serviceIntervalMonths } : {})}
          />
        </div>

        <ModalFooter>
          <Button variant="secondary" onClick={stäng}>
            Avbryt
          </Button>
          <Button variant="primary" onClick={spara} disabled={skapa.isPending}>
            {skapa.isPending ? 'Sparar…' : 'Lägg till'}
          </Button>
        </ModalFooter>
      </div>
    </Modal>
  )
}
