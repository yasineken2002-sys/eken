/**
 * RÄTTNING-1 — IMPORTENS MÅL FÅR INTE BYTAS, OCH ETT OGILTIGT MÅL FÅR INTE SKICKAS.
 *
 * ── VAD SOM MÄTS, OCH VARFÖR DET INTE RÄCKTE MED DET GAMLA PROVET ───────────
 *
 * `bankkonto.test.tsx` mätte att komponenterna FINNS och att formuläret beter
 * sig. Det rörde aldrig kontoväljaren eller importspärren, och kunde därför inte
 * se granskarens två fynd:
 *
 *   G1  enkonto-fallbacken räknades om vid varje rendering. Blev A avvecklat och
 *       B aktivt efter att filen valts pekade uttrycket om sig till B, utan en
 *       enda valhändelse. Uppmätt: submittedAccount "account-b", 0 val.
 *   G2  `kontoläge` räknade fram "välj" medan knappen var aktiv och handlern
 *       skickade det avvecklade kontot. Uppmätt både för CSV och för PDF.
 *
 * Proven nedan räknar därför ANROP, inte bara text: noll i felfallen, exakt ett
 * efter ett nytt uttryckligt val.
 *
 * ── VAD PROVEN INTE KAN SE ──────────────────────────────────────────────────
 *
 * Att servern avvisar ett inaktivt konto. Det ägs av `BankAccountService`
 * (`resolveTarget`) och är oförändrat — grinden här finns för att slippa en
 * onödig misslyckad import, inte för att ersätta den. Proven kör mot mockade
 * hooks i jsdom; hela kedjan mäts i `apps/web/e2e/bankkonto-import.spec.ts`.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  bindEnkonto,
  importmål,
  kontolistläge,
  nyImportomgång,
  type Bankkonto,
  type Importmål,
} from './api/reconciliation.api'

const A: Bankkonto = { id: 'konto-a', name: 'Konto A', accountNumber: null, isActive: true }
const B: Bankkonto = { id: 'konto-b', name: 'Konto B', accountNumber: null, isActive: true }
const A_AVVECKLAT: Bankkonto = { ...A, isActive: false }

// ── Mockade hooks. Listan och anropen styrs per prov. ────────────────────────
let konton: Bankkonto[] | undefined = [A]
let listanLaddar = false
let listanFel = false
const importMutate = vi.fn()
const pdfMutate = vi.fn()
const bekräftaMutate = vi.fn()
const hämtaIgen = vi.fn()

vi.mock('./hooks/useReconciliation', async (original) => ({
  ...(await original<object>()),
  useBankAccounts: () => ({
    data: konton,
    isPending: listanLaddar,
    isError: listanFel,
    isLoading: listanLaddar,
    refetch: hämtaIgen,
  }),
  useImportStatement: () => ({
    mutate: importMutate,
    isPending: false,
    isError: false,
    error: null,
  }),
  useImportPdfStatement: () => ({
    mutate: pdfMutate,
    isPending: false,
    isError: false,
    error: null,
  }),
  useConfirmPdfImport: () => ({
    mutate: bekräftaMutate,
    isPending: false,
    isError: false,
    error: null,
  }),
  useCancelPdfImport: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('@/hooks/useCanWrite', () => ({ useCanWrite: () => true }))

import { ImportModal } from './ReconciliationPage'
import { PdfImportPreviewModal } from './components/PdfImportPreviewModal'

beforeEach(() => {
  konton = [A]
  listanLaddar = false
  listanFel = false
  importMutate.mockReset()
  pdfMutate.mockReset()
  bekräftaMutate.mockReset()
  hämtaIgen.mockReset()
})
afterEach(cleanup)

const modal = () => (
  <ImportModal
    open
    onClose={() => undefined}
    onSuccess={() => undefined}
    onPdfDraft={() => undefined}
  />
)
const väljare = () => document.querySelector('#bankkonto') as HTMLSelectElement
const importknapp = () => screen.getByRole('button', { name: 'Importera' }) as HTMLButtonElement
const bifogaFil = () => {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, {
    target: {
      files: [new File(['Datum;Belopp\n2026-03-02;1'], 'utdrag.csv', { type: 'text/csv' })],
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
describe('rena funktioner — beslutsmodellen', () => {
  it('ett FEL är inte en användbar lista, även när gammal data ligger kvar', () => {
    // React Query behåller senaste lyckade svaret när en omhämtning faller. Att
    // läsa `data` först hade gjort nätfelet osynligt.
    expect(kontolistläge({ data: [A], isPending: false, isError: true })).toEqual({
      typ: 'okänt',
      orsak: 'fel',
    })
  })

  it('en pågående BAKGRUNDSHÄMTNING med data kvar är användbar', () => {
    // Normal uppdatering får inte stoppa operatören mitt i arbetet.
    expect(kontolistläge({ data: [A], isPending: false, isError: false })).toEqual({
      typ: 'användbar',
      konton: [A],
    })
  })

  it('utan data är läget okänt, inte tomt', () => {
    // "Inga konton" och "vi vet inte än" kräver olika svar.
    expect(kontolistläge({ data: undefined, isPending: true, isError: false })).toEqual({
      typ: 'okänt',
      orsak: 'laddar',
    })
  })

  it('G1: ett BUNDET mål som blivit ogiltigt ersätts INTE av det kvarvarande kontot', () => {
    const utfall = importmål(
      { typ: 'användbar', konton: [A_AVVECKLAT, B] },
      {
        typ: 'bundet',
        id: A.id,
      },
    )
    expect(utfall.id).toBeNull()
    expect(utfall.kräverNyttVal).toBe(true)
    expect(utfall.besked).toContain('avvecklat')
    // MOTPROVET: hade fallbacken funnits kvar hade svaret varit konto-b.
    expect(utfall.id).not.toBe(B.id)
  })

  it('G1: ett giltigt mål ligger kvar när ett konto TILLKOMMER', () => {
    expect(importmål({ typ: 'användbar', konton: [A, B] }, { typ: 'bundet', id: A.id }).id).toBe(
      A.id,
    )
  })

  it('bindningen sker EN gång, och byter aldrig ett redan bestämt mål', () => {
    expect(bindEnkonto({ typ: 'användbar', konton: [A] }, { typ: 'obestämt' })).toEqual({
      typ: 'bundet',
      id: A.id,
    })
    // Redan bestämt → ingen ändring, oavsett hur listan ser ut.
    expect(bindEnkonto({ typ: 'användbar', konton: [B] }, { typ: 'bundet', id: A.id })).toBeNull()
    expect(bindEnkonto({ typ: 'användbar', konton: [B] }, { typ: 'valt', id: A.id })).toBeNull()
    // Flera aktiva är en valsituation, inte en bindning.
    expect(bindEnkonto({ typ: 'användbar', konton: [A, B] }, { typ: 'obestämt' })).toBeNull()
    // Ett okänt läge binder ingenting.
    expect(bindEnkonto({ typ: 'okänt', orsak: 'fel' }, { typ: 'obestämt' })).toBeNull()
  })

  it('ny importomgång: uttryckligt val följer med, automatisk bindning gör det inte', () => {
    const valt: Importmål = { typ: 'valt', id: A.id }
    expect(nyImportomgång(valt)).toEqual(valt)
    expect(nyImportomgång({ typ: 'bundet', id: A.id })).toEqual({ typ: 'obestämt' })
    expect(nyImportomgång({ typ: 'obestämt' })).toEqual({ typ: 'obestämt' })
  })

  it('ett borttaget konto får ett annat besked än ett avvecklat', () => {
    const borta = importmål({ typ: 'användbar', konton: [B] }, { typ: 'valt', id: A.id })
    expect(borta.besked).toContain('finns inte längre')
    expect(borta.id).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('ImportModal — noll anrop i felfallen, ett efter nytt val', () => {
  it('G1: A ensam aktiv → A avvecklat/B aktivt utan val ⇒ inget byte, noll anrop', () => {
    const { rerender } = render(modal())
    bifogaFil()
    // Bunden till A, knappen går att trycka på.
    expect(väljare().value).toBe(A.id)
    expect(importknapp().disabled).toBe(false)

    konton = [A_AVVECKLAT, B]
    rerender(modal())

    // DET HÄR ÄR FYNDET: tidigare stod här konto-b, aktiv knapp, noll val.
    expect(väljare().value).not.toBe(B.id)
    expect(importknapp().disabled).toBe(true)
    expect(screen.getByTestId('import-kontobesked').textContent).toContain('avvecklat')

    fireEvent.click(importknapp())
    expect(importMutate).not.toHaveBeenCalled()
  })

  it('G2: uttryckligt A som blivit avvecklat ⇒ spärrad, noll anrop', () => {
    konton = [A, B]
    const { rerender } = render(modal())
    bifogaFil()
    fireEvent.change(väljare(), { target: { value: A.id } })
    expect(importknapp().disabled).toBe(false)

    konton = [A_AVVECKLAT, B]
    rerender(modal())

    expect(importknapp().disabled).toBe(true)
    fireEvent.click(importknapp())
    expect(importMutate).not.toHaveBeenCalled()
  })

  it('…och efter ett NYTT uttryckligt val går importen igenom — exakt ett anrop med rätt id', () => {
    // Motprovet till de två ovan. Utan det kan en spärr som aldrig släpper se ut
    // som en korrekt spärr.
    konton = [A, B]
    const { rerender } = render(modal())
    bifogaFil()
    fireEvent.change(väljare(), { target: { value: A.id } })
    konton = [A_AVVECKLAT, B]
    rerender(modal())

    fireEvent.change(väljare(), { target: { value: B.id } })
    expect(importknapp().disabled).toBe(false)
    fireEvent.click(importknapp())

    expect(importMutate).toHaveBeenCalledTimes(1)
    expect(importMutate.mock.calls[0]?.[0]).toMatchObject({ bankAccountId: B.id })
  })

  it('ett NYTT konto i listan ändrar inte ett giltigt mål', () => {
    const { rerender } = render(modal())
    bifogaFil()
    expect(väljare().value).toBe(A.id)

    konton = [A, B]
    rerender(modal())

    expect(väljare().value).toBe(A.id)
    fireEvent.click(importknapp())
    expect(importMutate).toHaveBeenCalledTimes(1)
    expect(importMutate.mock.calls[0]?.[0]).toMatchObject({ bankAccountId: A.id })
  })

  it('kontolistan kunde inte hämtas ⇒ spärrad med egen text och en väg tillbaka', () => {
    konton = undefined
    listanFel = true
    render(modal())
    bifogaFil()
    expect(screen.getByTestId('import-kontolage').textContent).toContain('kunde inte hämtas')
    expect(importknapp().disabled).toBe(true)
    fireEvent.click(screen.getByTestId('import-hamta-konton-igen'))
    expect(hämtaIgen).toHaveBeenCalledTimes(1)
  })

  it('laddning är INTE ett fel — inget larm, ingen Försök igen-knapp', () => {
    konton = undefined
    listanLaddar = true
    render(modal())
    expect(screen.getByTestId('import-kontolage').getAttribute('role')).toBe('status')
    expect(screen.queryByTestId('import-hamta-konton-igen')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('PdfImportPreviewModal — samma grind', () => {
  const draft = (bankAccountId?: string) =>
    ({
      id: 'draft-1',
      status: 'PARSED' as const,
      ...(bankAccountId ? { bankAccountId } : {}),
      parsed: {
        bank: 'Testbanken',
        accountNumber: null,
        periodStart: null,
        periodEnd: null,
        transactions: [
          {
            date: '2026-03-02',
            description: 'Inbetalning',
            ocr: null,
            amount: 1000,
            isIncoming: true,
          },
        ],
      },
    }) as Parameters<typeof PdfImportPreviewModal>[0]['draft']

  const bekräfta = () =>
    screen.getByRole('button', { name: /Bekräfta & matcha/ }) as HTMLButtonElement

  it('G2: ett mål som blivit avvecklat spärrar bekräftelsen — noll anrop', () => {
    konton = [A_AVVECKLAT, B]
    render(
      <PdfImportPreviewModal
        draft={draft(A.id)}
        onClose={() => undefined}
        onConfirmed={() => undefined}
      />,
    )
    expect(bekräfta().disabled).toBe(true)
    expect(screen.getByTestId('pdf-malbesked').textContent).toContain('avvecklat')
    fireEvent.click(bekräfta())
    expect(bekräftaMutate).not.toHaveBeenCalled()
  })

  it('ett giltigt mål bekräftas — exakt ett anrop med draftens konto', () => {
    // Motprovet. Och samtidigt beviset att PDF-målet inte byts: listan bär två
    // konton, och bekräftelsen skickar det draften bär.
    konton = [A, B]
    render(
      <PdfImportPreviewModal
        draft={draft(A.id)}
        onClose={() => undefined}
        onConfirmed={() => undefined}
      />,
    )
    expect(bekräfta().disabled).toBe(false)
    fireEvent.click(bekräfta())
    expect(bekräftaMutate).toHaveBeenCalledTimes(1)
    expect(bekräftaMutate.mock.calls[0]?.[0]).toMatchObject({ bankAccountId: A.id })
  })

  it('kontolistan kunde inte hämtas ⇒ bekräftelsen spärras, noll anrop', () => {
    konton = undefined
    listanFel = true
    render(
      <PdfImportPreviewModal
        draft={draft(A.id)}
        onClose={() => undefined}
        onConfirmed={() => undefined}
      />,
    )
    expect(bekräfta().disabled).toBe(true)
    fireEvent.click(bekräfta())
    expect(bekräftaMutate).not.toHaveBeenCalled()
  })

  it('en draft utan mål spärras fortfarande', () => {
    konton = [A]
    render(
      <PdfImportPreviewModal
        draft={draft()}
        onClose={() => undefined}
        onConfirmed={() => undefined}
      />,
    )
    // Och INGEN uppslagning till "det enda aktiva kontot" — en PDF får aldrig
    // tilldelas ett konto i efterhand.
    expect(bekräfta().disabled).toBe(true)
    expect(screen.getByTestId('pdf-malbesked').textContent).toContain('bär inget målkonto')
  })
})
