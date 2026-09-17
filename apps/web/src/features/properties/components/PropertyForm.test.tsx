import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PropertyForm } from './PropertyForm'
import { createProperty, updateProperty } from '../api/properties.api'
import type { CreatePropertyInput } from '@eken/shared'

const transport = vi.hoisted(() => ({
  post: vi.fn().mockResolvedValue({}),
  patch: vi.fn().mockResolvedValue({}),
}))
vi.mock('@/lib/api', () => ({ ...transport, get: vi.fn(), del: vi.fn() }))
const input: CreatePropertyInput = {
  name: 'N'.repeat(200),
  propertyDesignation: 'F056 1:1',
  type: 'RESIDENTIAL',
  address: { street: 'Testgatan 1', city: 'Teststad', postalCode: '111 22', country: 'SE' },
  totalArea: 100,
  yearBuilt: 2000,
}
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
function form(values: CreatePropertyInput, onSubmit = vi.fn()) {
  render(
    <PropertyForm
      defaultValues={values}
      onSubmit={onSubmit}
      onCancel={() => {}}
      isSubmitting={false}
    />,
  )
  return onSubmit
}
function save() {
  fireEvent.submit(screen.getByRole('button', { name: 'Spara' }).closest('form')!)
}

describe('F056 actual property form and request gates', () => {
  it.each([199, 200])(
    '%i-character name can be created and retained during an unrelated city edit',
    async (length) => {
      const values = { ...input, name: 'N'.repeat(length) }
      const submit = form(values)
      save()
      await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
      const created = submit.mock.calls[0]![0] as CreatePropertyInput
      await createProperty(created)
      expect(transport.post).toHaveBeenCalledWith('/properties', created)
      cleanup()
      const edit = form(created)
      fireEvent.change(screen.getByLabelText('Stad'), { target: { value: 'Ny stad' } })
      save()
      await waitFor(() => expect(edit).toHaveBeenCalledTimes(1))
      const updated = edit.mock.calls[0]![0] as CreatePropertyInput
      expect(updated.name).toBe(values.name)
      expect(updated.address.city).toBe('Ny stad')
      await updateProperty('id', updated)
      expect(transport.patch).toHaveBeenCalledWith('/properties/id', updated)
    },
  )

  it.each([
    ['long name', { ...input, name: 'N'.repeat(201) }, /högst 200/],
    [
      'bad postal code',
      { ...input, address: { ...input.address, postalCode: 'abc' } },
      /Ogiltigt postnummer/,
    ],
    ['area below existing API minimum', { ...input, totalArea: 0.5 }, /minst 1/],
    ['future year', { ...input, yearBuilt: new Date().getFullYear() + 1 }, /Byggår/],
    ['blank designation', { ...input, propertyDesignation: '   ' }, /Fastighetsbeteckning krävs/],
  ] as const)('%s is shown at the field before submission', async (_label, values, message) => {
    const submit = form(values)
    save()
    await screen.findByText(message)
    expect(submit).not.toHaveBeenCalled()
    expect(transport.post).not.toHaveBeenCalled()
  })

  it('blank optional building year is omitted, never sent as empty or null', async () => {
    const submit = form(input)
    fireEvent.change(screen.getByLabelText('Byggår (valfritt)'), { target: { value: '' } })
    save()
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    expect(submit.mock.calls[0]![0]).not.toHaveProperty('yearBuilt')
  })

  it('historical invalid name is visible and needs explicit correction before a full form edit', async () => {
    const historicalName = 'N'.repeat(201)
    const submit = form({ ...input, name: historicalName })
    expect((screen.getByLabelText('Fastighetsnamn') as HTMLInputElement).value).toBe(historicalName)
    fireEvent.change(screen.getByLabelText('Stad'), { target: { value: 'Ny stad' } })
    save()
    await screen.findByText(/högst 200/)
    expect(submit).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Fastighetsnamn'), { target: { value: 'Rättat namn' } })
    save()
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    expect(submit.mock.calls[0]![0]).toMatchObject({
      name: 'Rättat namn',
      address: { city: 'Ny stad' },
    })
  })

  it.each([
    { ...input, name: 'N'.repeat(201) },
    { ...input, address: { ...input.address, postalCode: 'abc' } },
  ])(
    'POST and PATCH request gates also reject invalid callers outside the form',
    async (invalid) => {
      await expect(createProperty(invalid)).rejects.toThrow()
      await expect(updateProperty('id', invalid)).rejects.toThrow()
      expect(transport.post).not.toHaveBeenCalled()
      expect(transport.patch).not.toHaveBeenCalled()
    },
  )

  it('the PATCH request gate still accepts intentionally partial and empty updates', async () => {
    await updateProperty('id', { name: 'Ny' })
    await updateProperty('id', {})
    expect(transport.patch.mock.calls).toEqual([
      ['/properties/id', { name: 'Ny' }],
      ['/properties/id', {}],
    ])
  })
})
