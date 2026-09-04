import { describe, expect, it } from 'vitest'
import {
  BANKID_INAKTIV,
  bankIdReducer,
  failText,
  hintText,
  pollOrderRef,
  type BankIdEvent,
  type BankIdState,
} from './bankid-flow'
import type { PortalAuthResult } from '@/types/portal.types'

const START = { orderRef: 'o-1', autoStartToken: 'ast', qrData: 'qr' }

const TENANT = {
  id: 't1',
  type: 'INDIVIDUAL' as const,
  email: 'a@b.se',
}

const SESSION: PortalAuthResult = {
  sessionToken: 'st',
  expiresAt: '2026-10-04T12:00:00.000Z',
  tenant: TENANT,
}

const KANDIDATER = [
  { tenantId: 't1', organizationName: 'Alfa AB', address: 'Storgatan 1, A1' },
  { tenantId: 't2', organizationName: 'Beta AB', address: null },
]

function kör(...events: BankIdEvent[]): BankIdState {
  return events.reduce(bankIdReducer, BANKID_INAKTIV)
}

describe('portalens BankID-tillståndsmaskin', () => {
  it('starta → pollar, med båda starthandtagen', () => {
    const s = kör({ typ: 'starta' }, { typ: 'startad', start: START })
    expect(s).toEqual({ steg: 'pollar', orderRef: 'o-1', autoStartToken: 'ast', qrData: 'qr' })
    expect(pollOrderRef(s)).toBe('o-1')
  })

  it('en start utan QR sätter inte fältet till undefined', () => {
    // `exactOptionalPropertyTypes` skiljer på "saknas" och "finns med värdet
    // undefined", och komponenten renderar QR-blocket på `state.qrData`.
    const s = kör({ typ: 'starta' }, { typ: 'startad', start: { orderRef: 'o-1' } })
    expect(Object.keys(s).sort()).toEqual(['orderRef', 'steg'])
  })

  it('pending behåller ordern och uppdaterar hjälptexten', () => {
    const s = kör(
      { typ: 'starta' },
      { typ: 'startad', start: START },
      { typ: 'svar', svar: { status: 'pending', hintCode: 'userSign' } },
    )
    expect(pollOrderRef(s)).toBe('o-1')
    expect(hintText((s as { hintCode?: string }).hintCode)).toBe(
      'Skriv in din säkerhetskod i BankID-appen',
    )
  })

  it('FELVÄG 1 — failed: egen text, och pollningen upphör', () => {
    const s = kör(
      { typ: 'starta' },
      { typ: 'startad', start: START },
      { typ: 'svar', svar: { status: 'failed', reason: 'userCancel' } },
    )
    expect(s).toEqual({ steg: 'fel', meddelande: 'Inloggningen avbröts' })
    expect(pollOrderRef(s)).toBeNull()
  })

  it('FELVÄG 2 — transportfel: eget meddelande, och knappen går att trycka igen', () => {
    const s = kör(
      { typ: 'starta' },
      { typ: 'startad', start: START },
      { typ: 'fel', meddelande: 'Något gick fel' },
    )
    expect(pollOrderRef(s)).toBeNull()
    expect(bankIdReducer(s, { typ: 'starta' })).toEqual({ steg: 'startar' })
  })

  it('complete → klar med hela sessionen', () => {
    const s = kör(
      { typ: 'starta' },
      { typ: 'startad', start: START },
      {
        typ: 'svar',
        svar: {
          status: 'complete',
          sessionToken: 'st',
          expiresAt: '2026-10-04T12:00:00.000Z',
          tenant: TENANT,
        },
      },
    )
    expect(s).toEqual({ steg: 'klar', session: SESSION })
  })

  it('choose → val, och pollningen upphör medan användaren väljer', () => {
    const s = kör(
      { typ: 'starta' },
      { typ: 'startad', start: START },
      { typ: 'svar', svar: { status: 'choose', chooseToken: 'ct', candidates: KANDIDATER } },
    )
    expect(s).toEqual({ steg: 'val', chooseToken: 'ct', candidates: KANDIDATER })
    // Ordern lever kvar tills valet gjorts, men KLIENTEN slutar polla — en
    // fortsatt pollning hade gett Conflict och sett ut som ett fel.
    expect(pollOrderRef(s)).toBeNull()
  })

  it('valet går genom EN EGEN händelse — ett `svar` hade tystnat i val-läget', () => {
    const val = kör(
      { typ: 'starta' },
      { typ: 'startad', start: START },
      { typ: 'svar', svar: { status: 'choose', chooseToken: 'ct', candidates: KANDIDATER } },
    )
    expect(
      bankIdReducer(val, {
        typ: 'svar',
        svar: {
          status: 'complete',
          sessionToken: 'st',
          expiresAt: '2026-10-04T12:00:00.000Z',
          tenant: TENANT,
        },
      }),
    ).toBe(val)
    expect(bankIdReducer(val, { typ: 'vald', session: SESSION })).toEqual({
      steg: 'klar',
      session: SESSION,
    })
  })

  it('EFTERSLÄNGARE: ett complete efter avbryt loggar inte in någon', () => {
    const s = kör(
      { typ: 'starta' },
      { typ: 'startad', start: START },
      { typ: 'avbryt' },
      {
        typ: 'svar',
        svar: {
          status: 'complete',
          sessionToken: 'st',
          expiresAt: '2026-10-04T12:00:00.000Z',
          tenant: TENANT,
        },
      },
    )
    expect(s).toEqual(BANKID_INAKTIV)
  })

  it('en `vald` utanför valet loggar inte in någon', () => {
    const pollar = kör({ typ: 'starta' }, { typ: 'startad', start: START })
    expect(bankIdReducer(pollar, { typ: 'vald', session: SESSION })).toBe(pollar)
  })
})

describe('texter', () => {
  it('okänd hintCode ger den neutrala raden, inte en gissning', () => {
    expect(hintText('nagotHeltNytt')).toBe('Väntar på BankID…')
    expect(hintText(undefined)).toBe('Väntar på BankID…')
  })

  it('okänd failReason avslöjar ingenting om systemet', () => {
    for (const kod of ['certificateErr', 'startFailed', 'nagotAnnat']) {
      expect(failText(kod)).toBe('Inloggningen kunde inte slutföras')
    }
    expect(failText('userCancel')).toBe('Inloggningen avbröts')
  })
})
