import { describe, expect, it } from 'vitest'
import {
  BANKID_INAKTIV,
  bankIdReducer,
  failText,
  hintText,
  pollOrderRef,
  skaPolla,
  type BankIdFlowState,
} from './bankid-flow'
import type { AuthResponse } from '@/stores/auth.store'

const SESSION = {
  accessToken: 'at',
  refreshToken: 'rt',
  user: { id: 'u1', email: 'a@b.se' },
  organization: { id: 'o1', name: 'Org AB', orgNumber: null, termsVersion: null },
} as unknown as AuthResponse

const START = { orderRef: 'o-1', autoStartToken: 'ast', qrData: 'qr' }

/** Kör en sekvens händelser från inaktivt läge. Läsbarare än nästlade anrop. */
function kör(...events: Parameters<typeof bankIdReducer>[1][]): BankIdFlowState {
  return events.reduce(bankIdReducer, BANKID_INAKTIV)
}

describe('BankID-flödets tillståndsmaskin', () => {
  it('starta → startar → pollar, med båda starthandtagen', () => {
    const s = kör({ typ: 'starta' }, { typ: 'startad', start: START })
    expect(s).toEqual({ steg: 'pollar', orderRef: 'o-1', autoStartToken: 'ast', qrData: 'qr' })
    expect(skaPolla(s)).toBe(true)
    expect(pollOrderRef(s)).toBe('o-1')
  })

  it('en start UTAN qrData och utan autoStartToken sätter inte fälten till undefined', () => {
    // `exactOptionalPropertyTypes` skiljer på "saknas" och "finns med värdet
    // undefined", och komponenten renderar QR-blocket på `qrData != null`. Ett
    // fält som FANNS med värdet undefined hade sett ut som närvarande i en
    // `in`-kontroll — därför prövas nyckelmängden, inte bara värdet.
    const s = kör({ typ: 'starta' }, { typ: 'startad', start: { orderRef: 'o-1' } })
    expect(Object.keys(s).sort()).toEqual(['orderRef', 'steg'])
  })

  it('pending behåller ordern och uppdaterar hjälptexten', () => {
    const s = kör(
      { typ: 'starta' },
      { typ: 'startad', start: START },
      { typ: 'svar', svar: { status: 'pending', hintCode: 'userSign' } },
    )
    expect(s.steg).toBe('pollar')
    expect(pollOrderRef(s)).toBe('o-1')
    expect(hintText((s as { hintCode?: string }).hintCode)).toBe(
      'Skriv in din säkerhetskod i BankID-appen',
    )
  })

  it('FELVÄG 1 — failed: avbruten ger sin egen text, och pollningen upphör', () => {
    const s = kör(
      { typ: 'starta' },
      { typ: 'startad', start: START },
      { typ: 'svar', svar: { status: 'failed', reason: 'userCancel' } },
    )
    expect(s).toEqual({ steg: 'fel', meddelande: 'Inloggningen avbröts' })
    expect(skaPolla(s)).toBe(false)
    expect(pollOrderRef(s)).toBeNull()
  })

  it('FELVÄG 2 — transportfel: eget meddelande, samma stopp', () => {
    // Ett nätverksfel är inte ett BankID-utfall och får inte se ut som ett.
    // Båda felvägarna ska ändå lämna flödet i ett läge där knappen går att
    // trycka igen — annars sitter användaren fast i en modal.
    const s = kör(
      { typ: 'starta' },
      { typ: 'startad', start: START },
      { typ: 'fel', meddelande: 'Inget konto är kopplat till detta BankID' },
    )
    expect(s).toEqual({ steg: 'fel', meddelande: 'Inget konto är kopplat till detta BankID' })
    expect(skaPolla(s)).toBe(false)
    expect(bankIdReducer(s, { typ: 'starta' })).toEqual({ steg: 'startar' })
  })

  it('complete med session → klar, med sessionen bärandes', () => {
    const s = kör(
      { typ: 'starta' },
      { typ: 'startad', start: START },
      { typ: 'svar', svar: { status: 'complete', session: SESSION } },
    )
    expect(s).toEqual({ steg: 'klar', session: SESSION })
  })

  it('complete UTAN session (anslutning) → klar med session null', () => {
    const s = kör(
      { typ: 'starta' },
      { typ: 'startad', start: START },
      { typ: 'svar', svar: { status: 'complete' } },
    )
    expect(s).toEqual({ steg: 'klar', session: null })
  })

  it('choose → val, och pollningen upphör medan användaren väljer', () => {
    const konton = [
      { userId: 'u1', organizationName: 'Alfa AB', role: 'OWNER' },
      { userId: 'u2', organizationName: 'Beta AB', role: 'ADMIN' },
    ]
    const s = kör(
      { typ: 'starta' },
      { typ: 'startad', start: START },
      { typ: 'svar', svar: { status: 'choose', chooseToken: 'ct', accounts: konton } },
    )
    expect(s).toEqual({ steg: 'val', chooseToken: 'ct', accounts: konton })
    // Ordern förbrukas inte förrän valet är gjort, men KLIENTEN slutar polla —
    // en fortsatt pollning hade gett Conflict och sett ut som ett fel.
    expect(skaPolla(s)).toBe(false)
  })

  it('kontovalet går genom EN EGEN händelse — ett `svar` hade tystnat i val-läget', () => {
    // Reduceraren ignorerar `svar` när flödet inte pollar (efterslängar-vakten
    // nedan), och efter ett kontoval gör det inte det. Vore valets resultat ett
    // `svar` hade händelsen tyst inte gjort någonting, och inloggningen hade
    // sett ut att hänga. Provet finns för att den skillnaden ska vara mätbar.
    const val = kör(
      { typ: 'starta' },
      { typ: 'startad', start: START },
      {
        typ: 'svar',
        svar: {
          status: 'choose',
          chooseToken: 'ct',
          accounts: [{ userId: 'u1', organizationName: 'Alfa AB', role: 'OWNER' }],
        },
      },
    )
    expect(
      bankIdReducer(val, { typ: 'svar', svar: { status: 'complete', session: SESSION } }),
    ).toBe(val)
    expect(bankIdReducer(val, { typ: 'vald', session: SESSION })).toEqual({
      steg: 'klar',
      session: SESSION,
    })
  })

  it('en `vald` utanför kontovalet loggar inte in någon', () => {
    const pollar = kör({ typ: 'starta' }, { typ: 'startad', start: START })
    expect(bankIdReducer(pollar, { typ: 'vald', session: SESSION })).toBe(pollar)
    expect(bankIdReducer(BANKID_INAKTIV, { typ: 'vald', session: SESSION })).toBe(BANKID_INAKTIV)
  })

  it('EFTERSLÄNGARE: ett complete efter avbryt loggar inte in någon', () => {
    // En poll som redan var i luften när användaren stängde modalen. Utan
    // vakten i reduceraren hade svaret satt `klar` och loggat in någon som just
    // sagt nej — och det syns inte i något renderat prov.
    const s = kör(
      { typ: 'starta' },
      { typ: 'startad', start: START },
      { typ: 'avbryt' },
      { typ: 'svar', svar: { status: 'complete', session: SESSION } },
    )
    expect(s).toEqual(BANKID_INAKTIV)
  })

  it('avbryt återställer helt — inget orderRef ligger kvar', () => {
    const s = kör({ typ: 'starta' }, { typ: 'startad', start: START }, { typ: 'avbryt' })
    expect(pollOrderRef(s)).toBeNull()
  })
})

describe('texter', () => {
  it('okänd hintCode ger den neutrala raden, inte en gissning', () => {
    expect(hintText('nagotHeltNytt')).toBe('Väntar på BankID…')
    expect(hintText(undefined)).toBe('Väntar på BankID…')
  })

  it('okänd failReason avslöjar ingenting om systemet', () => {
    // certificateErr, startFailed, transactionExpired hos providern … alla ska
    // ge samma neutrala mening. En text per kod hade beskrivit vårt inre för den
    // som inte ska se det.
    for (const kod of ['certificateErr', 'startFailed', 'nagotAnnat']) {
      expect(failText(kod)).toBe('Inloggningen kunde inte slutföras')
    }
    expect(failText('userCancel')).toBe('Inloggningen avbröts')
  })
})
