import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Momsval, momsvalText } from './Momsval'

describe('TESTKUND-041 Momsval (kundtext 033 §0)', () => {
  afterEach(cleanup)

  it('moms > 0: två uttryckliga val med beloppseffekt, inget förval, ingen «Ingen moms»', () => {
    const onChange = vi.fn()
    render(<Momsval moms={250} brutto={1250} value="" onChange={onChange} testid="mv" />)
    const val = screen.getAllByRole('radio')
    expect(val).toHaveLength(2)
    expect(val.every((v) => !(v as HTMLInputElement).checked)).toBe(true)
    expect(screen.getByText(/dras av \(bokas som ingående moms\)/)).toBeTruthy()
    expect(screen.getByText(/dras inte av \(ingår i kostnaden/)).toBeTruthy()
    expect(screen.queryByText('Ingen moms på fakturan')).toBeNull()
    fireEvent.click(val[1]!)
    expect(onChange).toHaveBeenCalledWith('INGET_AVDRAG')
  })

  it('moms 0: bara «Ingen moms på fakturan»', () => {
    render(<Momsval moms={0} brutto={1000} value="" onChange={vi.fn()} testid="mv" />)
    expect(screen.getAllByRole('radio')).toHaveLength(1)
    expect(screen.getByText('Ingen moms på fakturan')).toBeTruthy()
  })

  it('texten beskriver bara beslut och belopp — inga interna ord', () => {
    for (const v of ['INGEN_MOMS', 'HELT_AVDRAG', 'INGET_AVDRAG'] as const) {
      const t = momsvalText(v, 250, 1250)
      expect(t).not.toMatch(/produktval|BFN|K2|K3|härledning|INGET_AVDRAG|HELT_AVDRAG/)
    }
  })
})
