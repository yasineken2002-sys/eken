/**
 * K1 — ATT LÄGGA UPP IMPORTENS MÅLKONTO FRÅN WEBBEN.
 *
 * ── VAD SOM FAKTISKT VAR TRASIGT ────────────────────────────────────────────
 *
 * Inte backend. `POST /reconciliation/bank-accounts`, `BankAccountService`,
 * `CreateBankAccountSchema` och DTO-pariteten fanns sedan #F034c. Det som
 * saknades var en ANROPARE: `useCreateBankAccount` hade noll förekomster i
 * `apps/web/src` medan de tolv övriga hookarna i samma fil hade exakt en var.
 * En ny organisation kunde alltså aldrig importera ett kontoutdrag utan att
 * någon gick förbi webben — vilket är precis vad kundprovet tvingades göra.
 *
 * ── VAD DET HÄR PROVET INTE KAN SE ──────────────────────────────────────────
 *
 * Att servern faktiskt skapar kontot, avvisar en annan organisations id eller
 * svarar 403 för fel roll. Allt nedan kör mot MOCKADE hooks i jsdom. Den halvan
 * ägs av `BankAccountService` och dess prov, och av Playwright-specen
 * `apps/web/e2e/bankkonto-import.spec.ts`, som kör hela vägen i en riktig
 * webbläsare mot ett riktigt API.
 *
 * Det ser heller inte att komponenterna är MONTERADE i sidan. Det bärs av
 * samma e2e-spec.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CreateBankAccountSchema } from '@eken/shared'

import {
  BANKKONTO_NAMN_MAX,
  BANKKONTO_NUMMER_MAX,
  bankkontoFältfel,
  bankkontoNyttolast,
} from './api/reconciliation.api'

import type { Bankkonto } from './api/reconciliation.api'
import type { CreateBankAccountInput } from '@eken/shared'

const konto = (över: Partial<Bankkonto> = {}): Bankkonto => ({
  id: 'k1',
  name: 'Företagskonto SEB',
  accountNumber: '5492-1234567',
  isActive: true,
  ...över,
})

// ── Mockad mutation. `mutate` sparas så antalet ANROP går att räkna, och
//    lägena styrs per prov: "pågår" (svaret har inte kommit) respektive
//    "svarar direkt" (onSuccess/onError körs synkront).
type Handlers = {
  onSuccess?: (k: Bankkonto) => void
  onError?: (e: unknown) => void
  onSettled?: () => void
}
let mutateMock = vi.fn()
let pending = false

vi.mock('./hooks/useReconciliation', () => ({
  useCreateBankAccount: () => ({ mutate: mutateMock, isPending: pending }),
  useBankAccounts: () => ({ data: bankkontolista, isLoading: false, isError: false, error: null }),
}))

let kanSkrivaVarde = true
vi.mock('@/hooks/useCanWrite', () => ({ useCanWrite: () => kanSkrivaVarde }))

let bankkontolista: Bankkonto[] | undefined = []

import { BankAccountForm } from './components/BankAccountForm'
import { BankAccountsCard } from './components/BankAccountsCard'

beforeEach(() => {
  mutateMock = vi.fn()
  pending = false
  kanSkrivaVarde = true
  bankkontolista = []
})
afterEach(cleanup)

const namnfalt = () => screen.getByLabelText('Namn på kontot') as HTMLInputElement
const nummerfalt = () => screen.getByLabelText('Kontonummer (valfritt)') as HTMLInputElement
const spara = () => screen.getByRole('button', { name: 'Spara konto' })

// ─────────────────────────────────────────────────────────────────────────────
describe('bankkontoFältfel — formulärets egna regler', () => {
  it('tomt namn avvisas, och bara det fältet pekas ut', () => {
    expect(bankkontoFältfel({ name: '   ', accountNumber: '' }, [])).toEqual({
      name: 'Kontot måste ha ett namn.',
    })
  })

  it('giltigt namn utan nummer ger inga fel', () => {
    expect(bankkontoFältfel({ name: 'Företagskonto', accountNumber: '' }, [])).toBeNull()
  })

  it('namn över schemats gräns avvisas — gränsen är läst ur schemat, inte gissad', () => {
    // Tröskeln skrivs ut i påståendet så en ändring i schemat syns här.
    const fel = bankkontoFältfel(
      { name: 'x'.repeat(BANKKONTO_NAMN_MAX + 1), accountNumber: '' },
      [],
    )
    expect(fel?.name).toContain(String(BANKKONTO_NAMN_MAX))
    // Och exakt på gränsen ska det GÅ — annars mäter provet en gräns som
    // ligger fel åt andra hållet.
    expect(bankkontoFältfel({ name: 'x'.repeat(BANKKONTO_NAMN_MAX), accountNumber: '' }, [])).toBe(
      null,
    )
  })

  it('kontonummer över gränsen avvisas, och NAMNET är fortfarande fritt från fel', () => {
    const fel = bankkontoFältfel(
      { name: 'Giltigt', accountNumber: '9'.repeat(BANKKONTO_NUMMER_MAX + 1) },
      [],
    )
    expect(fel?.accountNumber).toContain(String(BANKKONTO_NUMMER_MAX))
    expect(fel?.name).toBeUndefined()
  })

  it('exakt dubblettnamn fångas före skick', () => {
    const fel = bankkontoFältfel({ name: '  Företagskonto SEB  ', accountNumber: '' }, [konto()])
    expect(fel?.name).toBe('Det finns redan ett konto som heter "Företagskonto SEB".')
  })

  it('SKIFTLÄGESSKILLNAD är INTE en dubblett — det unika villkoret är exakt', () => {
    // `@@unique([organizationId, name])` i Prisma jämför exakt. Att blockera
    // här hade nekat ett namn servern tillåter, och felet hade varit osynligt
    // (operatören tror att namnet är taget).
    expect(bankkontoFältfel({ name: 'företagskonto seb', accountNumber: '' }, [konto()])).toBeNull()
  })
})

describe('bankkontoNyttolast — det som faktiskt skickas', () => {
  it('trimmar och tar med kontonumret när det finns', () => {
    expect(bankkontoNyttolast({ name: '  Konto  ', accountNumber: ' 1234 ' })).toEqual({
      name: 'Konto',
      accountNumber: '1234',
    })
  })

  it('UTELÄMNAR tomt kontonummer i stället för att skicka tom sträng', () => {
    const kropp = bankkontoNyttolast({ name: 'Konto', accountNumber: '   ' })
    expect(kropp).toEqual({ name: 'Konto' })
    expect('accountNumber' in kropp).toBe(false)
  })

  it('nyttolasten passerar det DELADE schemat — samma som API:ts DTO bundits mot', () => {
    const kropp: CreateBankAccountInput = bankkontoNyttolast({
      name: 'Företagskonto',
      accountNumber: '5492-1234567',
    })
    expect(CreateBankAccountSchema.safeParse(kropp).success).toBe(true)
    // NEGATIV RIKTNING: schemat ska kunna säga nej. Utan den här raden vore det
    // gröna svaret ovan lika förenligt med ett schema som accepterar allt.
    expect(CreateBankAccountSchema.safeParse({ name: '' }).success).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('BankAccountForm — vägen som saknades', () => {
  it('skickar namn och kontonummer när formuläret är giltigt', () => {
    render(<BankAccountForm befintliga={[]} onSkapat={vi.fn()} />)
    fireEvent.change(namnfalt(), { target: { value: 'Företagskonto SEB' } })
    fireEvent.change(nummerfalt(), { target: { value: '5492-1234567' } })
    fireEvent.click(spara())
    expect(mutateMock).toHaveBeenCalledTimes(1)
    expect(mutateMock.mock.calls[0]?.[0]).toEqual({
      name: 'Företagskonto SEB',
      accountNumber: '5492-1234567',
    })
  })

  it('tomt namn skickar INGENTING och visar fältfelet', () => {
    render(<BankAccountForm befintliga={[]} onSkapat={vi.fn()} />)
    fireEvent.click(spara())
    expect(mutateMock).not.toHaveBeenCalled()
    expect(screen.getByText('Kontot måste ha ett namn.')).toBeTruthy()
  })

  it('DUBBELKLICK ger exakt ETT anrop — även när isPending inte hunnit bli true', () => {
    // Det här är hela poängen med `pågår`-referensen. React Query sätter
    // `isPending` via state, och två klick i samma tick hinner båda läsa
    // `false`. Provet håller därför `pending` kvar på false med flit — tar man
    // bort referensen blir svaret 2.
    render(<BankAccountForm befintliga={[]} onSkapat={vi.fn()} />)
    fireEvent.change(namnfalt(), { target: { value: 'Konto' } })
    fireEvent.click(spara())
    fireEvent.click(spara())
    expect(mutateMock).toHaveBeenCalledTimes(1)
  })

  it('…men spärren SLÄPPER när svaret kommit — den är inte ett permanent lås', () => {
    // Motprovet till ovan. En spärr som aldrig öppnar hade också gett "1" i
    // provet ovanför, och de två utfallen går inte att skilja utan den här.
    mutateMock = vi.fn((_kropp: CreateBankAccountInput, h: Handlers) => {
      h.onSuccess?.(konto())
      h.onSettled?.()
    })
    render(<BankAccountForm befintliga={[]} onSkapat={vi.fn()} />)
    fireEvent.change(namnfalt(), { target: { value: 'Konto A' } })
    fireEvent.click(spara())
    fireEvent.change(namnfalt(), { target: { value: 'Konto B' } })
    fireEvent.click(spara())
    expect(mutateMock).toHaveBeenCalledTimes(2)
  })

  it('lyckat svar: onSkapat får kontot och fälten töms', () => {
    const skapat = konto({ id: 'nytt' })
    mutateMock = vi.fn((_k: CreateBankAccountInput, h: Handlers) => {
      h.onSuccess?.(skapat)
      h.onSettled?.()
    })
    const onSkapat = vi.fn()
    render(<BankAccountForm befintliga={[]} onSkapat={onSkapat} />)
    fireEvent.change(namnfalt(), { target: { value: 'Företagskonto SEB' } })
    fireEvent.click(spara())
    expect(onSkapat).toHaveBeenCalledWith(skapat)
    expect(namnfalt().value).toBe('')
  })

  it('409 från servern visas som SERVERNS text, och formuläret står kvar', () => {
    // Servern vet vilket namn som är taget; att formulera om beskedet här hade
    // gett två versioner av samma sak.
    mutateMock = vi.fn((_k: CreateBankAccountInput, h: Handlers) => {
      h.onError?.({
        isAxiosError: true,
        response: {
          status: 409,
          data: { error: { message: 'Det finns redan ett konto som heter "Företagskonto".' } },
        },
      })
      h.onSettled?.()
    })
    render(<BankAccountForm befintliga={[]} onSkapat={vi.fn()} />)
    fireEvent.change(namnfalt(), { target: { value: 'Företagskonto' } })
    fireEvent.click(spara())
    expect(screen.getByRole('alert').textContent).toContain('redan ett konto som heter')
    // Fälten töms INTE — den som ska byta namn ska slippa skriva om alltihop.
    expect(namnfalt().value).toBe('Företagskonto')
  })

  it('403 visas som ett NEKANDE, inte som ett haveri', () => {
    mutateMock = vi.fn((_k: CreateBankAccountInput, h: Handlers) => {
      h.onError?.({ isAxiosError: true, response: { status: 403, data: {} } })
      h.onSettled?.()
    })
    render(<BankAccountForm befintliga={[]} onSkapat={vi.fn()} />)
    fireEvent.change(namnfalt(), { target: { value: 'Konto' } })
    fireEvent.click(spara())
    expect(screen.getByRole('alert').textContent).toContain(
      'Din roll får inte lägga upp bankkonton',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('BankAccountsCard — hantering och tomt läge', () => {
  it('tomt läge säger både vad som saknas och vad det hindrar', () => {
    bankkontolista = []
    render(<BankAccountsCard />)
    expect(screen.getByTestId('bank-accounts-tomt').textContent).toContain(
      'Importen av kontoutdrag kräver ett namngivet konto',
    )
  })

  it('listar kontona och märker det avvecklade — det döljs INTE', () => {
    // Ett konto som finns men inte går att välja är annars ett osynligt skäl
    // till att importen inte fungerar.
    bankkontolista = [konto(), konto({ id: 'k2', name: 'Gammalt konto', isActive: false })]
    render(<BankAccountsCard />)
    expect(screen.getByText('Företagskonto SEB')).toBeTruthy()
    expect(screen.getByText('Gammalt konto')).toBeTruthy()
    expect(screen.getByText('Avvecklat')).toBeTruthy()
  })

  it('FLERA aktiva konton säger att valet är operatörens', () => {
    bankkontolista = [konto(), konto({ id: 'k2', name: 'Klientmedelskonto' })]
    render(<BankAccountsCard />)
    expect(screen.getByText(/2 aktiva konton/)).toBeTruthy()
  })

  it('skiljer importkontot från fakturans bankgiro och från PSD2', () => {
    render(<BankAccountsCard />)
    const text = screen.getByTestId('bank-accounts-card').textContent ?? ''
    expect(text).toContain('målet för importen')
    expect(text).toContain('bankgirot som står på fakturan')
    expect(text).toContain('PSD2')
  })

  it('roll utan skrivrätt får INGEN skapa-knapp — och får veta vem som kan', () => {
    kanSkrivaVarde = false
    render(<BankAccountsCard />)
    expect(screen.queryByTestId('lagg-till-bankkonto')).toBeNull()
    expect(screen.getByTestId('bank-accounts-tomt').textContent).toContain(
      'Be en administratör lägga upp det.',
    )
  })

  it('roll MED skrivrätt får knappen', () => {
    // Motprovet: utan det kan provet ovan vara grönt av att knappen aldrig
    // renderas alls.
    render(<BankAccountsCard />)
    expect(screen.getByTestId('lagg-till-bankkonto')).toBeTruthy()
  })
})
