/**
 * I2 · FRIVILLIG SKATTSKYLDIGHET SOM UTTRYCKLIGT VAL I OBJEKTFORMULÄRET
 *
 * Formuläret visar reglaget bara för typer där flaggan påverkar momsregelns
 * sats — härlett ur samma `vatRateForRent` som fakturan läser, inte ur en egen
 * lista — och skickar alltid ett uttryckligt `true`/`false`. För bostad och
 * parkering skickas `false`, så en lokal som byter typ inte bär med sig en
 * flagga servern skulle avvisa.
 *
 * Vad provet INTE kan se: att servern sparar värdet och avvisar fel typ ägs av
 * `apps/api/src/units/unit-frivillig-skattskyldighet.db.spec.ts`.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CreateUnitInput } from '@eken/shared'

const FASTIGHET = '11111111-1111-4111-8111-111111111111'

vi.mock('@/features/properties/hooks/useProperties', () => ({
  useProperties: () => ({ data: [{ id: FASTIGHET, name: 'Ekens Gård 1' }], isLoading: false }),
}))

import { UnitForm } from './UnitForm'

afterEach(cleanup)

const ETIKETT = /frivilligt skattskyldig för moms/i

function rendera(defaultValues: Partial<CreateUnitInput> = {}) {
  const onSubmit = vi.fn<(d: CreateUnitInput) => void>()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <UnitForm
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        isSubmitting={false}
        defaultValues={{
          propertyId: FASTIGHET,
          name: 'Objekt',
          unitNumber: '0101',
          type: 'OFFICE',
          status: 'VACANT',
          area: 40,
          monthlyRent: 12000,
          ...defaultValues,
        }}
      />
    </QueryClientProvider>,
  )
  return { onSubmit }
}

const typ = (v: string) => fireEvent.change(screen.getByLabelText('Typ'), { target: { value: v } })
const spara = () => fireEvent.click(screen.getByRole('button', { name: 'Spara' }))

describe('reglaget för frivillig skattskyldighet', () => {
  it.each(['OFFICE', 'RETAIL', 'STORAGE', 'OTHER'])('%s: reglaget visas, avmarkerat som standard', (t) => {
    rendera({ type: t as CreateUnitInput['type'] })
    const kryss = screen.getByLabelText(ETIKETT) as HTMLInputElement
    expect(kryss.checked).toBe(false)
  })

  it.each(['APARTMENT', 'PARKING'])('%s: inget reglage', (t) => {
    rendera({ type: t as CreateUnitInput['type'] })
    expect(screen.queryByLabelText(ETIKETT)).toBeNull()
  })

  it('lokal: kryss → kroppen bär true', async () => {
    const { onSubmit } = rendera()
    fireEvent.click(screen.getByLabelText(ETIKETT))
    spara()
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0].voluntaryTaxLiability).toBe(true)
  })

  it('lokal utan kryss: kroppen bär ett UTTRYCKLIGT false', async () => {
    const { onSubmit } = rendera()
    spara()
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0]).toHaveProperty('voluntaryTaxLiability', false)
  })

  it('redigering av en lokal med flaggan: reglaget är ikryssat, och avkryssning skickar false', async () => {
    const { onSubmit } = rendera({ voluntaryTaxLiability: true })
    const kryss = screen.getByLabelText(ETIKETT) as HTMLInputElement
    expect(kryss.checked).toBe(true)
    fireEvent.click(kryss)
    spara()
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0].voluntaryTaxLiability).toBe(false)
  })

  it('lokal med kryss som byter typ till bostad: reglaget försvinner och false skickas', async () => {
    const { onSubmit } = rendera({ voluntaryTaxLiability: true })
    typ('APARTMENT')
    expect(screen.queryByLabelText(ETIKETT)).toBeNull()
    spara()
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ type: 'APARTMENT', voluntaryTaxLiability: false })
  })

  it('bostad: ett giltigt bostadsobjekt sparas med false, som förut i sak', async () => {
    const { onSubmit } = rendera({ type: 'APARTMENT' })
    spara()
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ type: 'APARTMENT', voluntaryTaxLiability: false })
  })
})
