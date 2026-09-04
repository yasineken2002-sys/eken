import { useEffect, useReducer, useState } from 'react'
import QRCode from 'qrcode'
import { bankIdChoose, bankIdCollect, bankIdStart, extractApiError } from '@/api/portal.api'
import {
  BANKID_INAKTIV,
  INGEN_HYRESGAST,
  bankIdReducer,
  hintText,
  pollOrderRef,
} from '@/lib/bankid-flow'
import type { PortalAuthResult } from '@/types/portal.types'
import styles from './BankIdLogin.module.css'

/** BankID:s egen rekommendation är ~2 s; tätare ger inget. */
const POLL_MS = 2000

/**
 * "Logga in med BankID" på hyresgästportalens inloggningssida.
 *
 * ── INGEN ANSLUTNING, TILL SKILLNAD FRÅN WEBBEN ───────────────────────────
 *
 * Hyresgästen behöver inte koppla sitt BankID först: hyresvärden har redan
 * registrerat personnumret i hyresavtalet, så kopplingen mellan människa och
 * hyresförhållande är gjord av den part som får göra den. Knappen är därför det
 * enda steget — och för en hyresgäst som aldrig aktiverat portalen är det den
 * FÖRSTA vägen in, inte ett alternativ till ett lösenord hen inte har.
 *
 * ── ALL LOGIK LIGGER I REDUCERAREN ────────────────────────────────────────
 *
 * Komponenten anropar, pollar och renderar. Varje beslut om vad ett svar BETYDER
 * ligger i `lib/bankid-flow.ts`, som är ren och prövad — inklusive de två fall
 * som annars aldrig blir prövade: ett svar som landar efter avbryt, och valet som
 * går genom en egen händelse.
 */
export function BankIdLogin({ onSession }: { onSession: (session: PortalAuthResult) => void }) {
  const [state, dispatch] = useReducer(bankIdReducer, BANKID_INAKTIV)
  const [qrUrl, setQrUrl] = useState<string | null>(null)
  const [valjer, setValjer] = useState(false)
  const orderRef = pollOrderRef(state)

  // ── Pollning ──────────────────────────────────────────────────────────────
  //
  // Egen timer och inte React Query: portalen har ingen etablerad
  // pollningskonvention, och en `setInterval` med explicit uppstädning är
  // lättare att läsa än en query som pollar. Uppstädningen är det som betyder
  // något — intervallet måste dö när ordern försvinner ELLER komponenten
  // avmonteras, annars pollar en stängd dialog vidare.
  useEffect(() => {
    if (!orderRef) return
    let stopp = false
    const id = setInterval(() => {
      if (stopp) return
      bankIdCollect(orderRef)
        .then((svar) => !stopp && dispatch({ typ: 'svar', svar }))
        .catch((err: unknown) => {
          if (stopp) return
          const status = (err as { response?: { status?: number } })?.response?.status
          dispatch({
            typ: 'fel',
            meddelande: status === 401 ? INGEN_HYRESGAST : extractApiError(err, 'Något gick fel'),
          })
        })
    }, POLL_MS)
    return () => {
      stopp = true
      clearInterval(id)
    }
  }, [orderRef])

  // ── QR ────────────────────────────────────────────────────────────────────
  const qrData = state.steg === 'pollar' ? state.qrData : undefined
  useEffect(() => {
    if (!qrData) {
      setQrUrl(null)
      return
    }
    let aktuell = true
    QRCode.toDataURL(qrData, { margin: 1, width: 208 })
      .then((url) => aktuell && setQrUrl(url))
      // Textfallbacken nedan tar över. Utan den blir utfallet en tom ruta,
      // alltså ett flöde som ser ut att hänga.
      .catch(() => aktuell && setQrUrl(null))
    return () => {
      aktuell = false
    }
  }, [qrData])

  useEffect(() => {
    if (state.steg === 'klar') onSession(state.session)
  }, [state, onSession])

  function starta() {
    dispatch({ typ: 'starta' })
    bankIdStart()
      .then((start) => dispatch({ typ: 'startad', start }))
      .catch((err: unknown) =>
        dispatch({ typ: 'fel', meddelande: extractApiError(err, 'BankID kunde inte startas') }),
      )
  }

  function valj(tenantId: string) {
    if (state.steg !== 'val') return
    setValjer(true)
    bankIdChoose(state.chooseToken, tenantId)
      .then((svar) => {
        if (svar.status !== 'complete') throw new Error('Oväntat svar')
        dispatch({
          typ: 'vald',
          session: {
            sessionToken: svar.sessionToken,
            expiresAt: svar.expiresAt,
            tenant: svar.tenant,
          },
        })
      })
      .catch((err: unknown) =>
        dispatch({ typ: 'fel', meddelande: extractApiError(err, 'Valet kunde inte slutföras') }),
      )
      .finally(() => setValjer(false))
  }

  const oppen = state.steg !== 'inaktiv' && state.steg !== 'klar'

  return (
    <>
      <div className={styles.divider}>
        <span className={styles.dividerLine} />
        <span className={styles.dividerText}>eller</span>
        <span className={styles.dividerLine} />
      </div>

      <button
        type="button"
        className={styles.button}
        onClick={starta}
        data-testid="bankid-login-button"
      >
        Logga in med BankID
      </button>

      {oppen && (
        <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="BankID">
          <div className={styles.panel} data-testid="bankid-panel">
            <p className={styles.panelTitle}>Logga in med BankID</p>

            {state.steg === 'startar' && <p className={styles.panelText}>Startar BankID…</p>}

            {state.steg === 'pollar' && (
              <>
                <p className={styles.panelText}>
                  Legitimera dig med BankID på den här enheten eller med QR-kod.
                </p>
                <div className={styles.qr}>
                  {qrUrl ? (
                    <img src={qrUrl} alt="QR-kod för BankID" width={208} height={208} />
                  ) : state.qrData ? (
                    <span className={styles.qrFallback}>{state.qrData}</span>
                  ) : (
                    <span className={styles.panelText}>
                      Ingen QR-kod. Använd knappen nedan på den här enheten.
                    </span>
                  )}
                </div>
                <p className={styles.hint}>{hintText(state.hintCode)}</p>
                {state.autoStartToken && (
                  <a
                    className={styles.autostart}
                    href={`bankid:///?autostarttoken=${state.autoStartToken}&redirect=null`}
                  >
                    Öppna BankID på den här enheten
                  </a>
                )}
              </>
            )}

            {state.steg === 'val' && (
              <>
                <p className={styles.panelText}>
                  Du är hyresgäst hos flera hyresvärdar. Välj vilken du vill logga in hos.
                </p>
                <div className={styles.candidates}>
                  {state.candidates.map((k) => (
                    <button
                      key={k.tenantId}
                      type="button"
                      className={styles.candidate}
                      disabled={valjer}
                      onClick={() => valj(k.tenantId)}
                      data-testid="bankid-candidate"
                    >
                      <span className={styles.candidateOrg}>{k.organizationName}</span>
                      {k.address && <span className={styles.candidateAddress}>{k.address}</span>}
                    </button>
                  ))}
                </div>
              </>
            )}

            {state.steg === 'fel' && (
              <>
                <p className={styles.error} data-testid="bankid-error">
                  {state.meddelande}
                </p>
                <button type="button" className={styles.button} onClick={starta}>
                  Försök igen
                </button>
              </>
            )}

            <button
              type="button"
              className={styles.cancel}
              onClick={() => dispatch({ typ: 'avbryt' })}
            >
              Avbryt
            </button>
          </div>
        </div>
      )}
    </>
  )
}
