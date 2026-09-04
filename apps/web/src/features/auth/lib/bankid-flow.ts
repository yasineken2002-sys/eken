import type {
  BankIdAccount,
  BankIdEnrollCollect,
  BankIdLoginCollect,
  BankIdStart,
} from '../api/bankid.api'
import type { AuthResponse } from '@/stores/auth.store'

/**
 * BankID-flödets tillståndsmaskin — REN, och därför prövbar.
 *
 * ── VARFÖR LOGIKEN INTE BOR I KOMPONENTEN ─────────────────────────────────
 *
 * Flödet är en sekvens med fem utfall (pending, failed, complete, choose, samt
 * ett transportfel), och den sortens logik i en komponent går bara att pröva
 * genom att rendera. `apps/web` kör vitest i `environment: 'node'` utan
 * react-plugin och utan testing-library (se vitest.config.ts) — ett prov som
 * renderar finns det alltså ingen väg till här, och att lägga till jsdom bara
 * för det hade varit att bygga miljön efter koden i stället för tvärtom.
 *
 * Reduceraren är dessutom det som gör felvägarna prövbara UTAN ett API: en
 * `failed` med `userCancel` och ett nätverksfel ska ge olika texter, och båda
 * ska lämna flödet i ett läge där knappen går att trycka på igen.
 *
 * ── DEN SKICKAR ALDRIG ETT userId ─────────────────────────────────────────
 *
 * Ingen händelse och inget tillstånd bär ett userId under identifieringen.
 * `val`-tillståndet bär konton att VISA, och först när användaren klickar går
 * ett userId till servern — som ändå kontrollerar att kontot hör till den
 * identifierade personen. Se `bankid.api.ts`.
 */

export interface BankIdPollingState {
  orderRef: string
  autoStartToken?: string
  qrData?: string
  hintCode?: string
}

export type BankIdFlowState =
  | { steg: 'inaktiv' }
  | { steg: 'startar' }
  | ({ steg: 'pollar' } & BankIdPollingState)
  | { steg: 'val'; chooseToken: string; accounts: BankIdAccount[] }
  /**
   * Klart. `session` är null för ANSLUTNINGSFLÖDET, som fullbordas utan att
   * någon loggas in — samma tillstånd, olika betydelse, och skillnaden står i
   * fältet i stället för i två nästan lika tillstånd.
   */
  | { steg: 'klar'; session: AuthResponse | null }
  | { steg: 'fel'; meddelande: string }

export type BankIdFlowEvent =
  | { typ: 'starta' }
  | { typ: 'startad'; start: BankIdStart }
  | { typ: 'svar'; svar: BankIdLoginCollect | BankIdEnrollCollect }
  /**
   * Kontovalet gick igenom. EGEN händelse, inte ett `svar` med status complete:
   * `svar` ignoreras med flit när flödet inte pollar (efterslängar-vakten), och
   * efter ett val gör det inte det. Att återanvända `svar` här hade gett en
   * händelse som tyst inte gör någonting — och den sortens fel syns inte i ett
   * gränssnitt förrän någon undrar varför inloggningen hänger.
   */
  | { typ: 'vald'; session: AuthResponse }
  | { typ: 'avbryt' }
  | { typ: 'fel'; meddelande: string }

export const BANKID_INAKTIV: BankIdFlowState = { steg: 'inaktiv' }

/**
 * Hjälptexter under pollningen. `hintCode` kommer från BankID och är
 * maskinläsbar; okända koder får INGEN gissad text utan faller tillbaka på den
 * neutrala raden — en påhittad översättning av en kod vi inte känner är värre än
 * ingen, eftersom den ser auktoritativ ut.
 */
const HINT_TEXTER: Record<string, string> = {
  outstandingTransaction: 'Starta BankID-appen',
  noClient: 'Starta BankID-appen',
  started: 'Skriv in din säkerhetskod i BankID-appen',
  userSign: 'Skriv in din säkerhetskod i BankID-appen',
  userMrtd: 'Följ instruktionerna i BankID-appen',
}

export function hintText(hintCode: string | undefined): string {
  return (hintCode && HINT_TEXTER[hintCode]) || 'Väntar på BankID…'
}

/**
 * Texter för en död order.
 *
 * INGEN AV DEM AVSLÖJAR NÅGOT OM KONTON. `userCancel` och `expiredTransaction`
 * säger vad användaren själv gjorde; allt annat samlas under en enda neutral
 * mening. Att skilja "certificateErr" från "startFailed" i gränssnittet hjälper
 * ingen och riskerar att beskriva systemets inre för den som inte ska se det.
 */
const FEL_TEXTER: Record<string, string> = {
  userCancel: 'Inloggningen avbröts',
  cancelled: 'Inloggningen avbröts',
  expiredTransaction: 'Tiden gick ut. Försök igen.',
}

export function failText(reason: string): string {
  return FEL_TEXTER[reason] ?? 'Inloggningen kunde inte slutföras'
}

/** Meddelandet när identifieringen gick igenom men inget konto är kopplat. */
export const INGET_KONTO = 'Inget konto är kopplat till detta BankID'

export function bankIdReducer(state: BankIdFlowState, event: BankIdFlowEvent): BankIdFlowState {
  switch (event.typ) {
    case 'starta':
      return { steg: 'startar' }

    case 'startad':
      // Fälten är valfria hos porten (olika brokers ger det ena eller andra), och
      // de utelämnas i stället för att sättas till undefined — `exactOptionalPropertyTypes`
      // skiljer på "saknas" och "finns med värdet undefined".
      return {
        steg: 'pollar',
        orderRef: event.start.orderRef,
        ...(event.start.autoStartToken ? { autoStartToken: event.start.autoStartToken } : {}),
        ...(event.start.qrData ? { qrData: event.start.qrData } : {}),
      }

    case 'svar': {
      // Ett svar som kommer när vi inte pollar är en efterslängare — en poll som
      // hann returnera efter att användaren avbrutit. Det får inte kunna logga in
      // någon i efterhand, och därför ignoreras det.
      if (state.steg !== 'pollar') return state
      const svar = event.svar
      if (svar.status === 'pending') {
        return {
          ...state,
          ...(svar.hintCode ? { hintCode: svar.hintCode } : {}),
        }
      }
      if (svar.status === 'failed') return { steg: 'fel', meddelande: failText(svar.reason) }
      if (svar.status === 'choose') {
        return { steg: 'val', chooseToken: svar.chooseToken, accounts: svar.accounts }
      }
      // 'complete'. Anslutningsflödet bär ingen session — då är flödet klart utan
      // att någon loggas in, och `session: null` säger exakt det.
      return { steg: 'klar', session: 'session' in svar ? svar.session : null }
    }

    case 'vald':
      // Bara från kontovalet. En `vald` i något annat läge är inte ett giltigt
      // steg och får inte logga in någon.
      return state.steg === 'val' ? { steg: 'klar', session: event.session } : state

    case 'avbryt':
      return BANKID_INAKTIV

    case 'fel':
      return { steg: 'fel', meddelande: event.meddelande }
  }
}

/** Ska klienten polla just nu? Enda stället frågan besvaras. */
export function skaPolla(state: BankIdFlowState): boolean {
  return state.steg === 'pollar'
}

/** orderRef att polla på, eller null. Bär aldrig något annat fält. */
export function pollOrderRef(state: BankIdFlowState): string | null {
  return state.steg === 'pollar' ? state.orderRef : null
}
