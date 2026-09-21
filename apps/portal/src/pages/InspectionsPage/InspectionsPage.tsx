import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  fetchInspections,
  fetchInspection,
  fetchInspectionImageCheck,
  fetchInspectionImageUrl,
  downloadInspectionPdf,
  fetchDeposits,
  extractApiError,
} from '@/api/portal.api'
import { Spinner } from '@/components/ui/Spinner'
import { ErrorCard } from '@/components/ui/ErrorCard'
import { openPresignedDownload, sanitizeFilename } from '@/lib/download'
import type {
  PortalBildkontrollUtfall,
  PortalDeposit,
  PortalInspection,
  PortalInspectionCondition,
  PortalInspectionListItem,
  PortalInspectionType,
} from '@/types/portal.types'
import styles from './InspectionsPage.module.css'

/**
 * HYRESGÄSTENS BESIKTNINGS- OCH DEPOSITIONSVY.
 *
 * Vyn är LÄSANDE. Den har medvetet ingen signering, ingen invändning och ingen
 * betalning — de frågorna handlar om vem som binder vem och till vad, och de
 * ska inte smygas in som en knapp i en läsvy.
 *
 * ── TRE SAKER SOM INTE FÅR GLIDA IHOP ──────────────────────────────────────
 *
 * Depositionskortet håller isär vad hyresvärden MOTTAGIT, vad hyresvärden
 * BESLUTAT om återbetalning, och om pengarna FAKTISKT betalats ut. Den sista
 * är alltid okänd: det finns ingen bankbekräftelse i systemet, och raden säger
 * det rent ut i stället för att utelämnas. Ett utelämnat fält läses som "inte
 * tillämpligt"; ett synligt "uppgift saknas" läses som det som är sant.
 *
 * ── "VERIFIERAD" SKRIVS ALDRIG UTAN UTFÖRD KONTROLL ────────────────────────
 *
 * Bilagornas kontroll körs på knapptryck och ger fyra utfall. Innan den körts
 * står ingenting alls om bilagornas äkthet.
 */

const TYP_TEXT: Record<PortalInspectionType, string> = {
  MOVE_IN: 'Inflyttningsbesiktning',
  MOVE_OUT: 'Utflyttningsbesiktning',
  PERIODIC: 'Periodisk besiktning',
  DAMAGE: 'Skadebesiktning',
}

const SKICK_TEXT: Record<PortalInspectionCondition, string> = {
  GOOD: 'Bra',
  ACCEPTABLE: 'Acceptabelt',
  DAMAGED: 'Skadat',
  MISSING: 'Saknas',
}

const STATUS_TEXT: Record<string, string> = {
  PENDING: 'Fakturerad, ej betald',
  PAID: 'Betald och förvaras',
  REFUND_PENDING: 'Väntar på återbetalning',
  REFUNDED: 'Återbetald',
  PARTIALLY_REFUNDED: 'Återbetald med avdrag',
  FORFEITED: 'Förverkad',
}

const KONTROLL_TEXT: Record<PortalBildkontrollUtfall | 'INGA_BILDER', string> = {
  VERIFIERAD: 'Innehållet är oförändrat sedan det laddades upp',
  AVVIKANDE: 'Innehållet är INTE detsamma som när bilden laddades upp',
  SAKNAS: 'Bilden kunde inte läsas — innehållet är okänt',
  DIGEST_SAKNAS: 'Bilden laddades upp innan kontrollen fanns och går inte att kontrollera',
  INGA_BILDER: 'Protokollet har inga bilder',
}

function datum(värde: string | null | undefined): string {
  if (!värde) return '—'
  return new Intl.DateTimeFormat('sv-SE', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(värde))
}

function kronor(belopp: number | string | null): string {
  if (belopp === null) return '—'
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    maximumFractionDigits: 0,
  }).format(Number(belopp))
}

/* ── Depositionen ──────────────────────────────────────────────────────────── */

function Depositionskort({ deposition }: { deposition: PortalDeposit }) {
  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <div>
          <p className={styles.cardTitle}>Deposition {kronor(deposition.belopp)}</p>
          <p className={styles.cardMeta}>
            {deposition.lease
              ? `${deposition.lease.unit.property.name} · ${deposition.lease.unit.name}`
              : 'Kopplad till ditt hyresavtal'}
          </p>
        </div>
        <span className={styles.badge}>{STATUS_TEXT[deposition.status] ?? deposition.status}</span>
      </div>

      <div className={styles.rowList}>
        <div className={styles.row}>
          <div>
            <p className={styles.rowLabel}>Mottagen betalning</p>
            <p className={styles.rowSub}>
              {deposition.mottagenBetalning
                ? `Registrerad av hyresvärden ${datum(deposition.mottagenBetalning.registreradAt)}`
                : 'Hyresvärden har inte registrerat depositionen som betald.'}
            </p>
          </div>
          <span className={deposition.mottagenBetalning ? styles.rowValue : styles.rowValueOkant}>
            {deposition.mottagenBetalning ? kronor(deposition.belopp) : 'Ej registrerad'}
          </span>
        </div>

        <div className={styles.row}>
          <div>
            <p className={styles.rowLabel}>Beslutade avdrag</p>
            {deposition.avdrag.length === 0 ? (
              <p className={styles.rowSub}>Inga avdrag är beslutade.</p>
            ) : (
              <ul className={styles.rowSub}>
                {deposition.avdrag.map((avdrag, i) => (
                  <li key={i}>
                    {avdrag.anledning}: {kronor(avdrag.belopp)}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <span className={styles.rowValue}>
            {deposition.avdrag.length === 0 ? '—' : kronor(deposition.avdragSumma)}
          </span>
        </div>

        <div className={styles.row}>
          <div>
            <p className={styles.rowLabel}>Beslutad återbetalning</p>
            <p className={styles.rowSub}>
              {deposition.beslutadAterbetalning
                ? `Beslutad och bokförd av hyresvärden ${datum(
                    deposition.beslutadAterbetalning.beslutadAt,
                  )}`
                : 'Ingen återbetalning är beslutad ännu.'}
            </p>
          </div>
          <span
            className={deposition.beslutadAterbetalning ? styles.rowValue : styles.rowValueOkant}
          >
            {deposition.beslutadAterbetalning
              ? kronor(deposition.beslutadAterbetalning.belopp)
              : '—'}
          </span>
        </div>

        {/* Den tredje uppgiften, och den viktigaste att inte glida på. */}
        <div className={styles.row}>
          <div>
            <p className={styles.rowLabel}>Genomförd utbetalning</p>
            <p className={styles.rowSub}>{deposition.genomfordUtbetalning.kommentar}</p>
          </div>
          <span className={styles.rowValueOkant}>Uppgift saknas</span>
        </div>
      </div>
    </div>
  )
}

/* ── Bilagornas kontroll ───────────────────────────────────────────────────── */

function Bildkontroll({ inspectionId }: { inspectionId: string }) {
  const kontroll = useQuery({
    queryKey: ['portal', 'inspections', inspectionId, 'bildkontroll'],
    queryFn: () => fetchInspectionImageCheck(inspectionId),
    // Startas bara av knappen. Utfallet gäller den sekund det mättes, så
    // ingenting serveras ur cachen vid nästa sidöppning.
    enabled: false,
    gcTime: 0,
    staleTime: 0,
  })

  if (kontroll.isFetching) {
    return <p className={`${styles.notis} ${styles.notisNeutral}`}>Kontrollerar bilagorna …</p>
  }

  if (kontroll.isError) {
    return (
      <div className={`${styles.notis} ${styles.notisFel}`}>
        <p>{extractApiError(kontroll.error, 'Kontrollen kunde inte utföras.')}</p>
        <button type="button" className={styles.btnLank} onClick={() => void kontroll.refetch()}>
          Försök igen
        </button>
      </div>
    )
  }

  if (!kontroll.data) {
    return (
      <div className={styles.actions}>
        <button type="button" className={styles.btn} onClick={() => void kontroll.refetch()}>
          Kontrollera bilagorna
        </button>
      </div>
    )
  }

  const { sammanfattning, bilder, kontrolleradAt } = kontroll.data
  const klass =
    sammanfattning === 'VERIFIERAD'
      ? styles.notisOk
      : sammanfattning === 'AVVIKANDE'
        ? styles.notisFel
        : styles.notisVarning

  return (
    <div className={`${styles.notis} ${klass}`}>
      <p>
        <strong>Kontrollerad {datum(kontrolleradAt)}.</strong> {KONTROLL_TEXT[sammanfattning]}
      </p>
      <ul>
        {bilder.map((bild) => (
          <li key={bild.imageId}>
            {bild.filename}: {KONTROLL_TEXT[bild.utfall]}
          </li>
        ))}
      </ul>
      <button type="button" className={styles.btnLank} onClick={() => void kontroll.refetch()}>
        Kontrollera igen
      </button>
    </div>
  )
}

/* ── Ett protokoll ─────────────────────────────────────────────────────────── */

function Protokollkort({ rad }: { rad: PortalInspectionListItem }) {
  const [oppet, setOppet] = useState(false)
  const [laddarPdf, setLaddarPdf] = useState(false)

  const detalj = useQuery({
    queryKey: ['portal', 'inspections', rad.id],
    queryFn: () => fetchInspection(rad.id),
    enabled: oppet,
  })

  async function laddaNedPdf() {
    if (laddarPdf) return
    setLaddarPdf(true)
    try {
      await downloadInspectionPdf(rad.id, rad.version)
    } catch (err) {
      toast.error('Kunde inte ladda ned protokollet', {
        description: extractApiError(err, 'Försök igen om en stund.'),
      })
    } finally {
      setLaddarPdf(false)
    }
  }

  async function oppnaBild(imageId: string, filnamn: string) {
    try {
      const { url, filename } = await fetchInspectionImageUrl(rad.id, imageId)
      openPresignedDownload(url, sanitizeFilename(filename || filnamn))
    } catch (err) {
      toast.error('Kunde inte öppna bilden', {
        description: extractApiError(err, 'Försök igen om en stund.'),
      })
    }
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <div>
          <p className={styles.cardTitle}>{TYP_TEXT[rad.type]}</p>
          <p className={styles.cardMeta}>
            {datum(rad.scheduledDate)} · {rad.unit.property.name}, {rad.unit.name}
          </p>
        </div>
      </div>

      <div className={styles.badgeRow}>
        <span className={`${styles.badge} ${styles.badgeGallande}`}>
          Gällande version {rad.version}
        </span>
        {rad.harRattelser && (
          <span className={styles.badge}>Rättad {rad.antalVersioner - 1} gång(er)</span>
        )}
        {rad.signedAt && <span className={styles.badge}>Signerad {datum(rad.signedAt)}</span>}
      </div>

      <div className={styles.actions}>
        <button type="button" className={styles.btn} onClick={() => setOppet((v) => !v)}>
          {oppet ? 'Dölj protokollet' : 'Visa protokollet'}
        </button>
        <button
          type="button"
          className={styles.btn}
          onClick={() => void laddaNedPdf()}
          disabled={laddarPdf}
        >
          {laddarPdf ? 'Hämtar …' : 'Ladda ned PDF'}
        </button>
      </div>

      {oppet && detalj.isLoading && <Spinner size="sm" label="Laddar protokollet..." />}

      {oppet && detalj.isError && (
        <div className={`${styles.notis} ${styles.notisFel}`}>
          <p>{extractApiError(detalj.error, 'Protokollet kunde inte hämtas.')}</p>
          <button type="button" className={styles.btnLank} onClick={() => void detalj.refetch()}>
            Försök igen
          </button>
        </div>
      )}

      {oppet && detalj.data && <Protokolldetalj protokoll={detalj.data} onOppnaBild={oppnaBild} />}
    </div>
  )
}

function Protokolldetalj({
  protokoll,
  onOppnaBild,
}: {
  protokoll: PortalInspection
  onOppnaBild: (imageId: string, filnamn: string) => Promise<void>
}) {
  const skador = protokoll.items.filter(
    (post) => post.condition === 'DAMAGED' || post.condition === 'MISSING',
  )

  return (
    <>
      {!protokoll.arGallande && (
        <p className={`${styles.notis} ${styles.notisVarning}`}>
          Den här versionen har ersatts av en senare. Det är den senaste versionen som gäller.
        </p>
      )}

      {protokoll.overallCondition && (
        <p className={`${styles.notis} ${styles.notisNeutral}`}>
          <strong>Helhetsbedömning:</strong> {protokoll.overallCondition}
        </p>
      )}

      {protokoll.notes && (
        <p className={`${styles.notis} ${styles.notisNeutral}`}>{protokoll.notes}</p>
      )}

      <p className={styles.sectionTitle} style={{ marginTop: 14 }}>
        Noterade skador
      </p>
      {skador.length === 0 ? (
        <p className={`${styles.notis} ${styles.notisOk}`}>
          Inga skador eller saknade föremål är noterade i protokollet.
        </p>
      ) : (
        <div className={styles.rowList}>
          {skador.map((post) => (
            <div key={post.id} className={styles.row}>
              <div>
                <p className={styles.rowLabel}>
                  {post.room} – {post.item}
                </p>
                <p className={styles.rowSub}>
                  {SKICK_TEXT[post.condition]}
                  {post.notes ? ` · ${post.notes}` : ''}
                </p>
              </div>
              <span className={post.repairCost ? styles.rowValue : styles.rowValueOkant}>
                {post.repairCost ? kronor(post.repairCost) : 'Inget belopp'}
              </span>
            </div>
          ))}
        </div>
      )}

      {protokoll.versioner.length > 1 && (
        <>
          <p className={styles.sectionTitle} style={{ marginTop: 14 }}>
            Rättelsehistorik
          </p>
          <div className={styles.rowList}>
            {protokoll.versioner.map((v) => (
              <div key={v.id} className={styles.row}>
                <div>
                  <p className={styles.rowLabel}>
                    Version {v.version}
                    {v.arGallande ? ' – gäller' : ''}
                  </p>
                  <p className={styles.rowSub}>
                    {v.correctionReason
                      ? `Rättad ${datum(v.correctedAt)}: ${v.correctionReason}`
                      : 'Ursprunglig version'}
                  </p>
                </div>
                <span className={v.arGallande ? styles.rowValue : styles.rowValueOkant}>
                  {v.arGallande ? 'Gäller' : 'Ersatt'}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {protokoll.images.length > 0 && (
        <>
          <p className={styles.sectionTitle} style={{ marginTop: 14 }}>
            Bilagor
          </p>
          <div className={styles.rowList}>
            {protokoll.images.map((bild) => (
              <div key={bild.id} className={styles.row}>
                <div>
                  <p className={styles.rowLabel}>{bild.filename}</p>
                  <p className={styles.rowSub}>
                    {bild.room ? `${bild.room} · ` : ''}
                    {bild.caption ?? 'Ingen bildtext'}
                  </p>
                </div>
                <button
                  type="button"
                  className={styles.btnLank}
                  onClick={() => void onOppnaBild(bild.id, bild.filename)}
                >
                  Öppna
                </button>
              </div>
            ))}
          </div>
          <Bildkontroll inspectionId={protokoll.id} />
        </>
      )}
    </>
  )
}

/* ── Sidan ─────────────────────────────────────────────────────────────────── */

export function InspectionsPage() {
  const protokoll = useQuery({
    queryKey: ['portal', 'inspections'],
    queryFn: fetchInspections,
  })
  const depositioner = useQuery({
    queryKey: ['portal', 'deposits'],
    queryFn: fetchDeposits,
  })

  if (protokoll.isLoading || depositioner.isLoading) {
    return <Spinner size="md" label="Laddar besiktningar..." />
  }

  // Båda felar var för sig: att fälla hela sidan för att den ena listan inte
  // gick att hämta hade dolt den andra utan skäl.
  if (protokoll.isError && depositioner.isError) {
    return (
      <ErrorCard
        onRetry={() => {
          void protokoll.refetch()
          void depositioner.refetch()
        }}
      />
    )
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.pageTitle}>Besiktning och deposition</h1>
        <p className={styles.pageLead}>
          Här ser du de besiktningsprotokoll din hyresvärd gjort tillgängliga för dig, och vad som
          hänt med din deposition. Sidan är läsande — har du synpunkter på ett protokoll eller ett
          avdrag tar du kontakt med din hyresvärd.
        </p>
      </div>

      <div className={styles.section}>
        <p className={styles.sectionTitle}>Deposition</p>
        {depositioner.isError && (
          <div className={`${styles.notis} ${styles.notisFel}`}>
            <p>{extractApiError(depositioner.error, 'Depositionen kunde inte hämtas.')}</p>
            <button
              type="button"
              className={styles.btnLank}
              onClick={() => void depositioner.refetch()}
            >
              Försök igen
            </button>
          </div>
        )}
        {depositioner.data?.length === 0 && (
          <div className={styles.empty}>
            <p className={styles.emptyText}>Ingen deposition är registrerad på ditt avtal</p>
            <p className={styles.emptySub}>
              Har du betalat en deposition men inte ser den här: kontakta din hyresvärd.
            </p>
          </div>
        )}
        {depositioner.data?.map((deposition) => (
          <Depositionskort key={deposition.id} deposition={deposition} />
        ))}
      </div>

      <div className={styles.section}>
        <p className={styles.sectionTitle}>Besiktningsprotokoll</p>
        {protokoll.isError && (
          <div className={`${styles.notis} ${styles.notisFel}`}>
            <p>{extractApiError(protokoll.error, 'Protokollen kunde inte hämtas.')}</p>
            <button
              type="button"
              className={styles.btnLank}
              onClick={() => void protokoll.refetch()}
            >
              Försök igen
            </button>
          </div>
        )}
        {protokoll.data?.length === 0 && (
          <div className={styles.empty}>
            <p className={styles.emptyText}>Inga besiktningsprotokoll är tillgängliga ännu</p>
            <p className={styles.emptySub}>
              Ett protokoll visas här när din hyresvärd slutfört besiktningen. Pågående besiktningar
              visas inte.
            </p>
          </div>
        )}
        {protokoll.data?.map((rad) => (
          <Protokollkort key={rad.id} rad={rad} />
        ))}
      </div>
    </div>
  )
}
