import type {
  PortalAuthResult,
  PortalBankIdCandidate,
  PortalBankIdCollect,
  PortalBankIdStart,
} from '@/types/portal.types'

/**
 * BankID-flödets tillståndsmaskin för HYRESGÄSTPORTALEN.
 *
 * ── VARFÖR EN EGEN OCH INTE WEBBENS ───────────────────────────────────────
 *
 * Formen är lik men flödet är inte samma: portalen har inget anslutningssteg
 * (hyresvärden har redan registrerat personnumret), och valet gäller HYRESVÄRD
 * i stället för konto — kandidaterna bär orgnamn och adress, inte roll. Att dela
 * en maskin mellan två appar hade dessutom krävt ett delat paket för två
 * tillståndstyper som redan skiljer sig i sina nyttolaster.
 *
 * Det som ÄR delat är reglerna, och de är medvetet desamma: okänd `hintCode`
 * ger den neutrala raden, okänd `failReason` avslöjar ingenting, ett svar som
 * landar efter avbryt ignoreras, och kontovalet går genom en egen händelse.
 */

export type BankIdState =
  | { steg: 'inaktiv' }
  | { steg: 'startar' }
  | {
      steg: 'pollar'
      orderRef: string
      autoStartToken?: string
      qrData?: string
      hintCode?: string
    }
  | { steg: 'val'; chooseToken: string; candidates: PortalBankIdCandidate[] }
  | { steg: 'klar'; session: PortalAuthResult }
  | { steg: 'fel'; meddelande: string }

export type BankIdEvent =
  | { typ: 'starta' }
  | { typ: 'startad'; start: PortalBankIdStart }
  | { typ: 'svar'; svar: PortalBankIdCollect }
  | { typ: 'vald'; session: PortalAuthResult }
  | { typ: 'avbryt' }
  | { typ: 'fel'; meddelande: string }

export const BANKID_INAKTIV: BankIdState = { steg: 'inaktiv' }

const HINT_TEXTER: Record<string, string> = {
  outstandingTransaction: 'Starta BankID-appen',
  noClient: 'Starta BankID-appen',
  started: 'Skriv in din säkerhetskod i BankID-appen',
  userSign: 'Skriv in din säkerhetskod i BankID-appen',
  userMrtd: 'Följ instruktionerna i BankID-appen',
}

/** Okänd kod ger den neutrala raden — en påhittad översättning ser auktoritativ ut. */
export function hintText(hintCode: string | undefined): string {
  return (hintCode && HINT_TEXTER[hintCode]) || 'Väntar på BankID…'
}

const FEL_TEXTER: Record<string, string> = {
  userCancel: 'Inloggningen avbröts',
  cancelled: 'Inloggningen avbröts',
  expiredTransaction: 'Tiden gick ut. Försök igen.',
}

export function failText(reason: string): string {
  return FEL_TEXTER[reason] ?? 'Inloggningen kunde inte slutföras'
}

/**
 * Texten när identifieringen lyckades men ingen hyresgäst matchade.
 *
 * Den säger vad som gäller för den som just legitimerat sig med SITT EGET
 * BankID, och pekar på rätt åtgärd: det är hyresvärden som registrerar
 * personnumret, så det är dit man vänder sig. Den avslöjar ingenting om någon
 * annan och bekräftar inte att en viss person finns i systemet.
 */
export const INGEN_HYRESGAST =
  'Inget hyresförhållande är kopplat till ditt personnummer. Kontakta din hyresvärd.'

export function bankIdReducer(state: BankIdState, event: BankIdEvent): BankIdState {
  switch (event.typ) {
    case 'starta':
      return { steg: 'startar' }

    case 'startad':
      return {
        steg: 'pollar',
        orderRef: event.start.orderRef,
        ...(event.start.autoStartToken ? { autoStartToken: event.start.autoStartToken } : {}),
        ...(event.start.qrData ? { qrData: event.start.qrData } : {}),
      }

    case 'svar': {
      // Efterslängare: en poll som redan var i luften när användaren avbröt. Den
      // får inte kunna logga in någon i efterhand.
      if (state.steg !== 'pollar') return state
      const svar = event.svar
      if (svar.status === 'pending') {
        return { ...state, ...(svar.hintCode ? { hintCode: svar.hintCode } : {}) }
      }
      if (svar.status === 'failed') return { steg: 'fel', meddelande: failText(svar.reason) }
      if (svar.status === 'choose') {
        return { steg: 'val', chooseToken: svar.chooseToken, candidates: svar.candidates }
      }
      return {
        steg: 'klar',
        session: {
          sessionToken: svar.sessionToken,
          expiresAt: svar.expiresAt,
          tenant: svar.tenant,
        },
      }
    }

    case 'vald':
      // Bara från valet. `svar` duger inte: den ignoreras med flit när flödet
      // inte pollar, och efter ett val gör det inte det — händelsen hade tyst
      // inte gjort någonting och inloggningen sett ut att hänga.
      return state.steg === 'val' ? { steg: 'klar', session: event.session } : state

    case 'avbryt':
      return BANKID_INAKTIV

    case 'fel':
      return { steg: 'fel', meddelande: event.meddelande }
  }
}

/** orderRef att polla på, eller null. Bär aldrig något annat fält. */
export function pollOrderRef(state: BankIdState): string | null {
  return state.steg === 'pollar' ? state.orderRef : null
}
