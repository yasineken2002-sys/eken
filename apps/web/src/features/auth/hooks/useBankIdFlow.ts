import { useCallback, useEffect, useReducer } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { extractApiError } from '@/lib/api'
import {
  BANKID_INAKTIV,
  INGET_KONTO,
  bankIdReducer,
  pollOrderRef,
  type BankIdFlowState,
} from '../lib/bankid-flow'
import {
  bankIdEnrollCollect,
  bankIdEnrollStart,
  bankIdLoginCollect,
  bankIdLoginStart,
  type BankIdEnrollCollect,
  type BankIdLoginCollect,
  type BankIdStart,
} from '../api/bankid.api'

/** Pollintervall. BankID:s egen rekommendation är ~2 s; tätare ger inget. */
export const POLL_MS = 2000

interface Vagar {
  start: () => Promise<BankIdStart>
  collect: (orderRef: string) => Promise<BankIdLoginCollect | BankIdEnrollCollect>
  /** Nyckelprefix så inloggning och anslutning inte delar cache-post. */
  nyckel: string
  /**
   * Texten vid 401 — bara inloggningsvägen har ett sådant utfall.
   *
   * Servern svarar med flit "Inloggningen kunde inte slutföras", samma text som
   * vid ett misslyckat BankID, för att inte avslöja om personnumret finns. Den
   * texten är rätt på servern och fel i gränssnittet: den som just har
   * legitimerat sig med SITT EGET BankID får veta att det inte är kopplat till
   * något konto, vilket inte säger något om någon annan.
   */
  ingetKontoText?: string
}

const LOGIN: Vagar = {
  start: bankIdLoginStart,
  collect: bankIdLoginCollect,
  nyckel: 'bankid-login',
  ingetKontoText: INGET_KONTO,
}

const ENROLL: Vagar = {
  start: bankIdEnrollStart,
  collect: bankIdEnrollCollect,
  nyckel: 'bankid-enroll',
}

/**
 * Driver ett BankID-flöde: start, pollning, och avslut.
 *
 * ── ALL LOGIK LIGGER I REDUCERAREN ────────────────────────────────────────
 *
 * Hooken gör tre saker — anropar start, pollar, och matar reduceraren. Varje
 * beslut om vad ett svar BETYDER ligger i `bankid-flow.ts`, som är ren och
 * prövad av `bankid-flow.spec.ts`. Skälet står i den filen: webs vitest kör i
 * node utan react-plugin, så ett prov som renderar finns det ingen väg till —
 * och logik i en hook är logik som inte går att pröva.
 *
 * ── VARFÖR useQuery OCH INTE EN setInterval ───────────────────────────────
 *
 * `refetchInterval` stannar av sig själv när `enabled` blir falskt, och React
 * Query avbryter den pågående hämtningen när komponenten avmonteras. En egen
 * timer hade behövt samma sak skriven för hand, och det är exakt den sortens kod
 * som glöms i felvägen: en modal som stängs mitt i en poll.
 *
 * Efterslängaren — en poll som redan var i luften när användaren avbröt — fångas
 * ändå av reduceraren, som ignorerar svar när flödet inte längre pollar.
 * Prövat: "EFTERSLÄNGARE: ett complete efter avbryt loggar inte in någon".
 */
function useFlow(vagar: Vagar) {
  const [state, dispatch] = useReducer(bankIdReducer, BANKID_INAKTIV)
  const orderRef = pollOrderRef(state)

  const starta = useCallback(() => {
    dispatch({ typ: 'starta' })
    vagar
      .start()
      .then((start) => dispatch({ typ: 'startad', start }))
      .catch((err: unknown) =>
        dispatch({ typ: 'fel', meddelande: extractApiError(err, 'BankID kunde inte startas') }),
      )
  }, [vagar])

  const avbryt = useCallback(() => dispatch({ typ: 'avbryt' }), [])

  const { data, error } = useQuery({
    queryKey: [vagar.nyckel, orderRef],
    queryFn: () => vagar.collect(orderRef as string),
    enabled: orderRef != null,
    refetchInterval: POLL_MS,
    // Ingen retry: varje poll ÄR ett nytt försök. En inbyggd retry hade dessutom
    // gjort att ett 401 ("inget konto") försöktes om innan felet nådde oss.
    retry: false,
    gcTime: 0,
  })

  useEffect(() => {
    if (data) dispatch({ typ: 'svar', svar: data })
  }, [data])

  useEffect(() => {
    if (!error) return
    const arDet401 = axios.isAxiosError(error) && error.response?.status === 401
    dispatch({
      typ: 'fel',
      meddelande:
        arDet401 && vagar.ingetKontoText
          ? vagar.ingetKontoText
          : extractApiError(error, 'Något gick fel'),
    })
  }, [error, vagar.ingetKontoText])

  return { state: state as BankIdFlowState, starta, avbryt, dispatch }
}

export function useBankIdLogin() {
  return useFlow(LOGIN)
}

export function useBankIdEnroll() {
  return useFlow(ENROLL)
}
