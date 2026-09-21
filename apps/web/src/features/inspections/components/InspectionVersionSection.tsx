import { useState } from 'react'
import { motion } from 'framer-motion'
import { History, ShieldCheck, ShieldAlert, ShieldQuestion, FileWarning } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { extractApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useCreateCorrection, useImageCheck, useInspectionVersions } from '../hooks/useInspections'
import { formatDate } from '@eken/shared'
import { INSPECTION_CORRECTION_REASON_MIN } from '@eken/shared'
import type {
  Inspection,
  InspectionVersion,
  BildkontrollUtfall,
  Depositionsvarning,
} from '../api/inspections.api'

interface Props {
  inspection: Inspection
  /** Öppnar en annan version i panelen. */
  onOppnaVersion: (id: string) => void
}

/**
 * VILKEN VERSION SOM GÄLLER, OCH HUR MAN RÄTTAR DEN SOM INTE GÖR DET.
 *
 * ── VARFÖR RUTAN LIGGER ÖVERST OCH INTE LÄNGST NER ─────────────────────────
 *
 * En läsare som inte vet att protokollet framför hen har ersatts läser fel
 * uppgift, inte mindre uppgift. Beskedet måste alltså komma FÖRE innehållet.
 *
 * ── VAD RÄTTELSEN INTE GÖR ─────────────────────────────────────────────────
 *
 * Den låser inte upp originalet, den flyttar inga filer och den rör inte ett
 * beslutat depositionsavdrag. Det sista står i klartext i bekräftelsen, därför
 * att det är den förväntan en förvaltare rimligen har: rättar jag protokollet
 * så rättas väl avdraget? Svaret är nej, och det ska stå innan knappen trycks
 * — inte upptäckas när pengarna inte stämmer.
 */

const UTFALLSTEXT: Record<BildkontrollUtfall, { text: string; cls: string }> = {
  VERIFIERAD: {
    text: 'Verifierad — innehållet är oförändrat sedan uppladdningen',
    cls: 'text-emerald-700',
  },
  AVVIKANDE: {
    text: 'Avviker — innehållet är INTE detsamma som vid uppladdningen',
    cls: 'text-red-600',
  },
  SAKNAS: { text: 'Kunde inte läsas ur lagringen — innehållet är okänt', cls: 'text-amber-700' },
  DIGEST_SAKNAS: {
    text: 'Ingen digest sparad — går inte att kontrollera',
    cls: 'text-gray-500',
  },
}

function VersionsRad({
  version,
  aktuell,
  onOppna,
}: {
  version: InspectionVersion
  aktuell: boolean
  onOppna: () => void
}) {
  return (
    <li
      className={cn(
        'border-line flex items-start gap-3 border-b px-3 py-2.5 last:border-0',
        aktuell && 'bg-gray-50',
      )}
    >
      <span
        className={cn(
          'mt-0.5 inline-flex h-5 min-w-[1.75rem] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold',
          version.arGallande
            ? 'bg-emerald-50 text-emerald-700'
            : version.arUtkast
              ? 'bg-amber-50 text-amber-700'
              : 'bg-gray-100 text-gray-500',
        )}
      >
        v{version.version}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-medium text-gray-800">
          {version.arGallande ? 'Gällande version' : version.arUtkast ? 'Utkast' : 'Ersatt version'}
          {aktuell && <span className="ml-1.5 text-[11px] text-gray-400">(visas nu)</span>}
        </p>
        {version.correctionReason && (
          <p className="mt-0.5 text-[12px] leading-relaxed text-gray-600">
            <span className="text-gray-400">Orsak:</span> {version.correctionReason}
          </p>
        )}
        <p className="mt-0.5 text-[11px] text-gray-400">
          {version.correctedAt
            ? `Rättad ${formatDate(version.correctedAt)}`
            : `Skapad ${formatDate(version.createdAt)}`}
          {version.signedAt ? ` · Signerad ${formatDate(version.signedAt)}` : ''}
        </p>
      </div>
      {!aktuell && (
        <button
          type="button"
          onClick={onOppna}
          className="mt-0.5 flex-shrink-0 text-[12px] font-semibold text-blue-600 underline underline-offset-2 hover:text-blue-700"
        >
          Öppna
        </button>
      )}
    </li>
  )
}

function Depositionsruta({ varning }: { varning: Depositionsvarning }) {
  return (
    <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[12px] font-semibold text-amber-900">
        <FileWarning size={13} strokeWidth={1.8} />
        Depositionen är redan reglerad
      </p>
      <p className="mt-1 text-[12px] leading-relaxed text-amber-900">
        Det finns {varning.avdragAntal} beslutat avdrag på depositionen (status {varning.status}
        {varning.refundedAt ? `, återbetalad ${formatDate(varning.refundedAt)}` : ''}). Rättelsen
        ändrar <strong>inte</strong> avdraget eller en genomförd återbetalning — det är bokförd
        räkenskapsinformation och måste hanteras separat i depositionsvyn.
      </p>
    </div>
  )
}

export function InspectionVersionSection({ inspection, onOppnaVersion }: Props) {
  // ── KEDJAN HÄMTAS, DEN ÄRVS INTE FRÅN LISTAN ──────────────────────────────
  //
  // Panelen öppnas ur listvyn (`GET /inspections`), och listan bär INTE kedjan
  // — den hade blivit en fråga per rad. Att läsa `inspection.versioner` här
  // hade alltså gett `undefined` i exakt det fall komponenten finns för, och
  // rutan hade tyst påstått "version 1 gäller" om varje protokoll.
  //
  // Egen hämtning mot `/inspections/:id/versioner` i stället. Den är enradig
  // per länk och kedjor är korta.
  const kedja = useInspectionVersions(inspection.id)
  const versioner = kedja.data ?? []
  const harKedja = versioner.length > 1

  // Den HÄR radens roll, läst ur kedjan. Innan kedjan hämtats vet vi ingenting
  // — och då påstås ingenting heller: rutan nedan visar ett laddningsläge.
  const migSjalv = versioner.find((v) => v.id === inspection.id) ?? null
  const arGallande = migSjalv?.arGallande ?? false
  const arUtkast = migSjalv?.arUtkast ?? false

  const [visaFormular, setVisaFormular] = useState(false)
  const [orsak, setOrsak] = useState('')
  const [fel, setFel] = useState<string | null>(null)
  const [senasteVarning, setSenasteVarning] = useState<Depositionsvarning | null>(null)

  const skapaRattelse = useCreateCorrection()
  const bildkontroll = useImageCheck(inspection.id)

  // Bara ett SLUTFÖRT protokoll kan rättas, och bara om ingen redan gjort det.
  // Samma villkor som servern prövar — knappen ska inte erbjuda något som
  // säkert nekas.
  const kanRattas =
    (inspection.status === 'COMPLETED' || inspection.status === 'SIGNED') &&
    inspection.correction === null

  const orsakForKort = orsak.trim().length < INSPECTION_CORRECTION_REASON_MIN

  const skicka = async () => {
    setFel(null)
    try {
      const svar = await skapaRattelse.mutateAsync({
        id: inspection.id,
        dto: {
          orsak: orsak.trim(),
          // Versionen användaren faktiskt läst. Har någon annan hunnit ändra
          // protokollet svarar servern 409 i stället för att rätta något annat.
          expectedContentHash: inspection.contentHash,
        },
      })
      setVisaFormular(false)
      setOrsak('')
      setSenasteVarning(svar.depositionsvarning)
      onOppnaVersion(svar.id)
    } catch (err: unknown) {
      setFel(extractApiError(err))
    }
  }

  return (
    <div className="border-line border-t pt-4">
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
        <History size={11} strokeWidth={1.8} />
        Version och rättelser
      </p>

      {kedja.isPending && <p className="text-[12px] text-gray-500">Läser versionshistoriken …</p>}

      {kedja.isError && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5">
          <p className="text-[12px] font-medium text-amber-900">{extractApiError(kedja.error)}</p>
          <button
            type="button"
            onClick={() => void kedja.refetch()}
            className="mt-1.5 text-[12px] font-semibold text-amber-900 underline underline-offset-2"
          >
            Försök igen
          </button>
        </div>
      )}

      {/* Vilken version detta ÄR — före innehållet, inte efter. */}
      {migSjalv && (
        <div
          className={cn(
            'rounded-xl px-3 py-2.5 text-[12px] leading-relaxed',
            arGallande
              ? 'border border-emerald-100 bg-emerald-50/60 text-emerald-800'
              : arUtkast
                ? 'border border-amber-200 bg-amber-50 text-amber-900'
                : 'border border-gray-200 bg-gray-50 text-gray-700',
          )}
        >
          {arGallande && (
            <>
              Detta är <strong>version {inspection.version}</strong> och den version som gäller.
            </>
          )}
          {arUtkast && (
            <>
              Detta är <strong>version {inspection.version}</strong> och ett <strong>utkast</strong>
              . Det gäller inte förrän det slutförts — fram till dess är den tidigare versionen den
              som gäller.
            </>
          )}
          {!arGallande && !arUtkast && (
            <>
              Detta är <strong>version {inspection.version}</strong> och har{' '}
              <strong>ersatts av en senare version</strong>. Läs den gällande versionen i listan
              nedan.
            </>
          )}
        </div>
      )}

      {harKedja && (
        <ul className="border-line mt-3 overflow-hidden rounded-xl border">
          {versioner.map((v) => (
            <VersionsRad
              key={v.id}
              version={v}
              aktuell={v.id === inspection.id}
              onOppna={() => onOppnaVersion(v.id)}
            />
          ))}
        </ul>
      )}

      {senasteVarning && <Depositionsruta varning={senasteVarning} />}

      {/* ── Rättelse ────────────────────────────────────────────────────── */}
      {kanRattas && !visaFormular && (
        <div className="mt-3">
          <Button size="sm" variant="secondary" onClick={() => setVisaFormular(true)}>
            Skapa rättelseversion
          </Button>
          <p className="mt-1.5 text-[11px] leading-relaxed text-gray-400">
            Originalet ändras aldrig. En rättelse skapar en ny version som är ett utkast tills den
            slutförts, och som ärver poster och bilagor.
          </p>
        </div>
      )}

      {kanRattas && visaFormular && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="border-line mt-3 rounded-xl border p-3"
        >
          <label
            htmlFor="rattelse-orsak"
            className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-gray-400"
          >
            Orsak till rättelsen (obligatorisk)
          </label>
          <textarea
            id="rattelse-orsak"
            value={orsak}
            onChange={(e) => setOrsak(e.target.value)}
            rows={3}
            placeholder="Beskriv vad som är fel i den här versionen och vad rättelsen avser."
            className="border-input w-full rounded-lg border px-2.5 py-2 text-[13px] text-gray-800 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <p className="mt-1 text-[11px] text-gray-400">
            Minst {INSPECTION_CORRECTION_REASON_MIN} tecken. Orsaken sparas i protokollets historik
            tillsammans med vem som rättade och när.
          </p>

          {fel && (
            <div className="mt-2.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
              <p className="text-[12px] font-medium text-amber-900">{fel}</p>
            </div>
          )}

          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              variant="primary"
              loading={skapaRattelse.isPending}
              disabled={orsakForKort}
              onClick={() => void skicka()}
            >
              Skapa rättelse
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setVisaFormular(false)
                setFel(null)
              }}
            >
              Avbryt
            </Button>
          </div>
        </motion.div>
      )}

      {inspection.correction && (
        <p className="mt-3 text-[12px] text-gray-500">
          Den här versionen är redan rättad (version {inspection.correction.version}). Rätta den
          senaste versionen i stället.
        </p>
      )}

      {/* ── Bildkontroll ────────────────────────────────────────────────── */}
      {inspection.images.length > 0 && (
        <div className="border-line mt-4 border-t pt-4">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
            Bilagornas innehåll
          </p>

          {!bildkontroll.data && !bildkontroll.isFetching && (
            <>
              <Button size="sm" variant="secondary" onClick={() => void bildkontroll.refetch()}>
                <ShieldQuestion size={13} strokeWidth={1.8} />
                Kontrollera bilagorna
              </Button>
              <p className="mt-1.5 text-[11px] leading-relaxed text-gray-400">
                Kontrollen läser tillbaka varje bilagas innehåll ur lagringen och jämför med den
                digest som sparades vid uppladdningen. Ingen bilaga är kontrollerad förrän du kör
                den.
              </p>
            </>
          )}

          {bildkontroll.isFetching && (
            <p className="text-[12px] text-gray-500">Läser tillbaka bilagorna …</p>
          )}

          {bildkontroll.isError && !bildkontroll.isFetching && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
              <p className="text-[12px] font-medium text-amber-900">
                {extractApiError(bildkontroll.error)}
              </p>
              <button
                type="button"
                onClick={() => void bildkontroll.refetch()}
                className="mt-1.5 text-[12px] font-semibold text-amber-900 underline underline-offset-2"
              >
                Försök igen
              </button>
            </div>
          )}

          {bildkontroll.data && !bildkontroll.isFetching && (
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-gray-700">
                {bildkontroll.data.sammanfattning === 'VERIFIERAD' ? (
                  <ShieldCheck size={13} strokeWidth={1.8} className="text-emerald-600" />
                ) : bildkontroll.data.sammanfattning === 'AVVIKANDE' ? (
                  <ShieldAlert size={13} strokeWidth={1.8} className="text-red-600" />
                ) : (
                  <ShieldQuestion size={13} strokeWidth={1.8} className="text-amber-600" />
                )}
                Kontrollerad {formatDate(bildkontroll.data.kontrolleradAt)}
              </p>
              <ul className="border-line overflow-hidden rounded-xl border">
                {bildkontroll.data.bilder.map((b) => (
                  <li key={b.imageId} className="border-line border-b px-3 py-2 last:border-0">
                    <p className="text-[12px] font-medium text-gray-800">{b.filename}</p>
                    <p className={cn('text-[12px]', UTFALLSTEXT[b.utfall].cls)}>
                      {UTFALLSTEXT[b.utfall].text}
                    </p>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => void bildkontroll.refetch()}
                className="mt-2 text-[12px] font-semibold text-blue-600 underline underline-offset-2 hover:text-blue-700"
              >
                Kontrollera igen
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
