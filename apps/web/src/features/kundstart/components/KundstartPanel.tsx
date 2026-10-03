import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, FileUp } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { extractApiError } from '@/lib/api'
import { useAuthStore } from '@/stores/auth.store'
import { getFortnoxSeriesCatalog } from '@/features/settings/api/fortnox-export.api'
import { startFortnoxRead } from '@/features/settings/api/fortnox.api'
import {
  approvePackage,
  bindRead,
  discardPackage,
  executePackage,
  fetchCutover,
  fetchPackage,
  fetchPackages,
  kr,
  replacePackageSource,
  saveCutover,
  setSeparateLedger,
  uploadPackage,
  validatePackage,
  type OpeningPackage,
} from '../api/kundstart.api'

/**
 * KUNDSTART-001: brytdatum och öppningspaket för historiska fordringar och depositioner.
 * Ingen ekonomisk effekt förrän OWNER har godkänt och verkställt. En differens mot
 * Fortnox kan inte godkännas bort här — den löses med rader, en rättelse i Fortnox eller
 * en verifierbar specifikation av separat reskontra (då kallas kontot aldrig avstämt).
 */
export const MALL_HUVUD =
  'radId;typ;hyresgast;avtal;fastighet;enhet;periodAr;periodManad;forfallodag;ursprungligtBelopp;oppetBelopp;mottagetDatum'

const STATUS_TEXT: Record<OpeningPackage['status'], string> = {
  DRAFT: 'Utkast',
  VALIDATED: 'Validerat',
  APPROVED: 'Godkänt',
  EXECUTED: 'Verkställt',
  DISCARDED: 'Kasserat',
}
const RECON_TEXT = {
  AVSTAMD: 'Avstämt',
  AVGRANSAD: 'Avgränsat (inte avstämt i sin helhet)',
  DIFFERENS: 'Oförklarad differens',
} as const

const dagenFore = (iso: string) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)

async function lasFil(f: File): Promise<string> {
  return f.text()
}

export function KundstartPanel() {
  const user = useAuthStore((s) => s.user)
  const org = useAuthStore((s) => s.organization)
  return <KundstartScoped key={`${org?.id ?? '-'}|${user?.id ?? '-'}|${user?.role ?? '-'}`} />
}

function KundstartScoped() {
  const role = useAuthStore((s) => s.user?.role)
  const isOwner = role === 'OWNER'
  const kanSkriva = role === 'OWNER' || role === 'ADMIN'
  const qc = useQueryClient()
  const cutover = useQuery({
    queryKey: ['kundstart', 'cutover'],
    queryFn: fetchCutover,
    retry: false,
  })
  const paket = useQuery({ queryKey: ['kundstart', 'paket'], queryFn: fetchPackages, retry: false })
  const [valt, setValt] = useState<string | null>(null)
  const [manad, setManad] = useState('')
  const [noll, setNoll] = useState(false)
  const refresh = () => qc.invalidateQueries({ queryKey: ['kundstart'] })

  const sparaBryt = useMutation({
    mutationFn: () => saveCutover(manad ? `${manad}-01` : null),
    onSuccess: refresh,
  })
  const ladda = useMutation({
    mutationFn: async (f: File) =>
      uploadPackage({ sourceName: f.name, innehall: await lasFil(f), nollOppning: noll }),
    onSuccess: async (p) => {
      setValt(p.id)
      await refresh()
    },
  })

  const mall = () => {
    const blob = new Blob([`${MALL_HUVUD}\n`], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'oppningspaket-mall.csv'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div className="min-w-0 space-y-5">
      <section
        aria-label="Brytdatum"
        className="border-line min-w-0 space-y-3 rounded-2xl border bg-white p-5"
      >
        <h3 className="text-ink text-[15px] font-semibold">Brytdatum</h3>
        <p className="text-ink-muted text-sm">
          Första dagen Eveno fakturerar. Perioder före brytdatum är fakturerade i ert tidigare
          system och skapas aldrig av Eveno — varken av månadsaviseringen, nya avtal eller
          efterdebitering. Historisk skuld och mottagna depositioner förs in med ett öppningspaket.
        </p>
        {cutover.isLoading ? (
          <p className="text-ink-muted text-sm">Hämtar…</p>
        ) : cutover.isError ? (
          <p className="text-sm text-red-600">
            {extractApiError(cutover.error, 'Brytdatum kunde inte hämtas.')}
          </p>
        ) : (
          <>
            <p className="text-ink text-sm">
              Gällande: <strong>{cutover.data?.cutoverDate ?? 'inget satt'}</strong>
            </p>
            {cutover.data?.locked && (
              <p className="text-sm text-amber-700">{cutover.data.lockReason}</p>
            )}
            {isOwner && !cutover.data?.locked && (
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-ink text-sm">
                  <span className="mb-1 block text-[12px] font-medium">Månad (den 1:a)</span>
                  <input
                    type="month"
                    aria-label="Brytdatum, månad"
                    value={manad}
                    onChange={(e) => setManad(e.target.value)}
                    className="rounded-lg border border-gray-200 px-3 py-2 text-sm"
                  />
                </label>
                <Button
                  size="sm"
                  disabled={!manad}
                  loading={sparaBryt.isPending}
                  onClick={() => sparaBryt.mutate()}
                >
                  Spara brytdatum
                </Button>
              </div>
            )}
            {!isOwner && (
              <p className="text-ink-muted text-[12px]">Bara ägaren (OWNER) sätter brytdatum.</p>
            )}
            {sparaBryt.error && (
              <p role="alert" className="text-sm text-red-600">
                {extractApiError(sparaBryt.error, 'Brytdatum kunde inte sparas.')}
              </p>
            )}
          </>
        )}
      </section>

      <section
        aria-label="Öppningspaket"
        className="border-line min-w-0 space-y-3 rounded-2xl border bg-white p-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-ink text-[15px] font-semibold">Öppningspaket</h3>
            <p className="text-ink-muted text-sm">
              Historiska öppna fordringar och mottagna depositioner per hyresgäst, ur ert
              reskontraunderlag. Inget bokförs i Eveno — beloppen finns redan i Fortnox.
            </p>
          </div>
          <Button size="sm" variant="secondary" onClick={mall}>
            Hämta mall (CSV)
          </Button>
        </div>
        {kanSkriva && cutover.data?.cutoverDate && (
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-sm">
              <FileUp size={15} />
              <span>Ladda upp paket (CSV)</span>
              <input
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                aria-label="Ladda upp öppningspaket"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) ladda.mutate(f)
                  e.target.value = ''
                }}
              />
            </label>
            <label className="text-ink inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={noll} onChange={(e) => setNoll(e.target.checked)} />
              Nollöppning (nytt bolag utan övertagna saldon — filen innehåller bara rubrikraden)
            </label>
          </div>
        )}
        {ladda.error && (
          <p role="alert" className="text-sm text-red-600">
            {extractApiError(ladda.error, 'Paketet kunde inte laddas upp.')}
          </p>
        )}
        {paket.isError ? (
          <p className="text-sm text-red-600">
            {extractApiError(paket.error, 'Paketen kunde inte hämtas.')}
          </p>
        ) : (paket.data ?? []).length === 0 ? (
          <p className="text-ink-muted text-sm">Inga paket ännu.</p>
        ) : (
          <ul className="divide-y divide-gray-100 rounded-xl border border-gray-100">
            {(paket.data ?? []).map((p) => (
              <li key={p.id}>
                <button
                  className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50"
                  aria-pressed={valt === p.id}
                  onClick={() => setValt(p.id)}
                >
                  <span className="min-w-0 flex-1 truncate font-medium">{p.sourceName}</span>
                  <Badge
                    variant={
                      p.status === 'EXECUTED'
                        ? 'success'
                        : p.status === 'DISCARDED'
                          ? 'default'
                          : 'info'
                    }
                  >
                    {STATUS_TEXT[p.status]}
                  </Badge>
                  <span className="text-ink-muted text-[12px]">v{p.version}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {valt && <PaketVy id={valt} cutoverDate={cutover.data?.cutoverDate ?? null} />}
    </div>
  )
}

function PaketVy({ id, cutoverDate }: { id: string; cutoverDate: string | null }) {
  const role = useAuthStore((s) => s.user?.role)
  const isOwner = role === 'OWNER'
  const kanSkriva = role === 'OWNER' || role === 'ADMIN'
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['kundstart', 'paket', id],
    queryFn: () => fetchPackage(id),
    retry: false,
  })
  const ar = useQuery({
    queryKey: ['kundstart', 'fortnox-ar'],
    queryFn: () => getFortnoxSeriesCatalog(null),
    enabled: kanSkriva,
    retry: false,
  })
  const [bekraftGodk, setBekraftGodk] = useState(false)
  const [bekraftVerk, setBekraftVerk] = useState(false)
  const [specKonto, setSpecKonto] = useState<'1510' | '2890'>('1510')
  const [specText, setSpecText] = useState('')
  const refresh = () => qc.invalidateQueries({ queryKey: ['kundstart'] })
  const validera = useMutation({ mutationFn: () => validatePackage(id), onSuccess: refresh })
  const ersatt = useMutation({
    mutationFn: async (f: File) =>
      replacePackageSource(id, {
        sourceName: f.name,
        innehall: await f.text(),
        nollOppning: q.data?.zeroOpening === true,
      }),
    onSuccess: refresh,
  })
  const lasOchBind = useMutation({
    mutationFn: async () => {
      if (!cutoverDate) throw new Error('Brytdatum saknas.')
      const sista = dagenFore(cutoverDate)
      const y = (ar.data?.financialYears ?? []).find((f) => f.from <= sista && sista <= f.to)
      if (!y) throw new Error(`Inget räkenskapsår i Fortnox omfattar ${sista}.`)
      const run = await startFortnoxRead({
        financialYearId: y.id,
        financialYearStart: y.from,
        financialYearEnd: y.to,
        periodFrom: y.from,
        periodTo: sista,
        costAccounts: [1510, 2890],
      })
      if (run.status !== 'COMPLETE')
        throw new Error(
          `Fortnox-läsningen blev ${run.status}: ${run.reason ?? 'ofullständig'} — den kan inte stämma av öppningen.`,
        )
      return bindRead(id, run.id)
    },
    onSuccess: refresh,
  })
  const spec = useMutation({
    mutationFn: async (f: File | null) =>
      setSeparateLedger(id, {
        konto: specKonto,
        beskrivning: specText,
        filnamn: f?.name ?? '',
        innehall: f ? await f.text() : null,
      }),
    onSuccess: refresh,
  })
  const godkann = useMutation({
    mutationFn: () =>
      approvePackage(id, { version: q.data!.version, sourceSha256: q.data!.sourceSha256 }),
    onSuccess: refresh,
  })
  const verkstall = useMutation({ mutationFn: () => executePackage(id), onSuccess: refresh })
  const kassera = useMutation({ mutationFn: () => discardPackage(id), onSuccess: refresh })

  if (q.isLoading) return <p className="text-ink-muted text-sm">Hämtar paketet…</p>
  if (q.isError || !q.data)
    return (
      <p className="text-sm text-red-600">
        {extractApiError(q.error, 'Paketet kunde inte hämtas.')}
      </p>
    )
  const p = q.data
  const fel = [validera, ersatt, lasOchBind, spec, godkann, verkstall, kassera]
    .map((x) => x.error)
    .find(Boolean)
  const levande = p.status !== 'EXECUTED' && p.status !== 'DISCARDED'

  return (
    <section
      aria-label="Paketets innehåll"
      className="border-line min-w-0 space-y-4 rounded-2xl border bg-white p-5"
    >
      <div className="min-w-0">
        <h3 className="text-ink break-words text-[15px] font-semibold">
          {p.sourceName} · version {p.version} · {STATUS_TEXT[p.status]}
          {p.zeroOpening && ' · nollöppning'}
        </h3>
        <p className="text-ink-muted break-all text-[12px]">
          Brytdatum {p.cutoverDate} · sha256 {p.sourceSha256}
        </p>
        {p.invalidatedReason && p.status !== 'EXECUTED' && (
          <p className="mt-1 text-sm text-amber-700">{p.invalidatedReason}</p>
        )}
      </div>

      <div className="grid min-w-0 gap-3 sm:grid-cols-3">
        <Siffra etikett="Fordringar (1510)" varde={kr(p.totals?.fordranOre)} />
        <Siffra etikett="Depositioner (2890)" varde={kr(p.totals?.depositionOre)} />
        <Siffra etikett="Rader / felrader" varde={`${p.rows.length} / ${p.felrader}`} />
      </div>

      <div className="space-y-2">
        <h4 className="text-ink text-sm font-semibold">
          Startavstämning mot Fortnox per brytdatum
        </h4>
        {p.reconciliation?.konton?.map((k) => (
          <div
            key={k.konto}
            className={`rounded-lg px-3 py-2 text-[13px] ${
              k.status === 'AVSTAMD'
                ? 'bg-emerald-50 text-emerald-800'
                : k.status === 'AVGRANSAD'
                  ? 'bg-amber-50 text-amber-800'
                  : 'bg-red-50 text-red-800'
            }`}
          >
            <p className="font-semibold">
              {k.konto}: paket {kr(k.paketOre)} · Fortnox {kr(k.fortnoxOre)} · differens{' '}
              {kr(k.differensOre)}
            </p>
            <p className="break-words">{k.text}</p>
          </div>
        ))}
        <p className="text-ink text-sm">
          Status:{' '}
          <strong>
            {p.reconciliationStatus
              ? RECON_TEXT[p.reconciliationStatus]
              : 'inte avstämd (Fortnox-saldo saknas)'}
          </strong>
        </p>
        {p.reconciliationStatus === 'DIFFERENS' && (
          <p className="flex items-start gap-1.5 text-sm text-red-700">
            <AlertTriangle size={15} className="mt-0.5 flex-shrink-0" />
            En oförklarad differens kan inte godkännas bort. Lös den med kompletterande rader (ny
            version), en spårbar rättelse i Fortnox (läs om saldot) eller en verifierbar
            specifikation av en separat reskontra. Kundaktivering är blockerad så länge.
          </p>
        )}
        {kanSkriva && p.status !== 'DISCARDED' && (
          <Button
            size="sm"
            variant="secondary"
            loading={lasOchBind.isPending}
            onClick={() => lasOchBind.mutate()}
          >
            Läs saldo per brytdatum ur Fortnox
          </Button>
        )}
        {kanSkriva &&
          p.status !== 'DISCARDED' &&
          !p.zeroOpening &&
          p.reconciliationStatus !== 'AVSTAMD' && (
            <details className="rounded-lg border border-gray-100 p-3">
              <summary className="cursor-pointer text-sm font-medium">
                Separat reskontra (avgränsat övertagande)
              </summary>
              <div className="mt-2 space-y-2">
                <p className="text-ink-muted text-[12px]">
                  Fil med rubriken postId;belopp. Summan måste vara exakt lika med differensen;
                  kontot redovisas då som avgränsat, aldrig som avstämt.
                </p>
                <select
                  aria-label="Konto för separat reskontra"
                  value={specKonto}
                  onChange={(e) => setSpecKonto(e.target.value as '1510' | '2890')}
                  className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm"
                >
                  <option value="1510">1510</option>
                  <option value="2890">2890</option>
                </select>
                <textarea
                  aria-label="Beskrivning av den separata reskontran"
                  value={specText}
                  onChange={(e) => setSpecText(e.target.value)}
                  rows={2}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                  placeholder="Vad reskontran är och var den förs (minst 20 tecken)"
                />
                <div className="flex flex-wrap gap-2">
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-gray-300 px-3 py-1.5 text-sm">
                    Välj specifikation
                    <input
                      type="file"
                      accept=".csv,text/csv"
                      className="sr-only"
                      aria-label="Specifikation av separat reskontra"
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (f) spec.mutate(f)
                        e.target.value = ''
                      }}
                    />
                  </label>
                  <Button size="sm" variant="ghost" onClick={() => spec.mutate(null)}>
                    Ta bort specifikation
                  </Button>
                </div>
              </div>
            </details>
          )}
      </div>

      <RadLista p={p} />

      {fel && (
        <p role="alert" className="text-sm text-red-600">
          {extractApiError(fel, 'Åtgärden misslyckades.')}
        </p>
      )}

      {levande && kanSkriva && (
        <div className="flex flex-wrap gap-2">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-gray-200 px-3 py-1.5 text-sm">
            Ny version (fil)
            <input
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              aria-label="Ny version av paketet"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) ersatt.mutate(f)
                e.target.value = ''
              }}
            />
          </label>
          {(p.status === 'DRAFT' || p.status === 'VALIDATED') && (
            <Button
              size="sm"
              variant="secondary"
              loading={validera.isPending}
              onClick={() => validera.mutate()}
            >
              Validera
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => kassera.mutate()}>
            Kassera
          </Button>
        </div>
      )}

      {p.status === 'VALIDATED' && (
        <div className="space-y-2 rounded-xl border border-gray-100 p-3">
          <h4 className="text-ink text-sm font-semibold">Godkännande (ägaren)</h4>
          {isOwner ? (
            <>
              <label className="text-ink flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={bekraftGodk}
                  onChange={(e) => setBekraftGodk(e.target.checked)}
                />
                <span>
                  Jag har granskat version {p.version} (sha {p.sourceSha256.slice(0, 12)}…) med{' '}
                  {p.rows.length} rader och avstämningen ovan. Godkännandet gäller bara denna fil,
                  detta brytdatum och detta ekonomiska läge.
                </span>
              </label>
              <Button
                size="sm"
                disabled={!bekraftGodk}
                loading={godkann.isPending}
                onClick={() => godkann.mutate()}
              >
                Godkänn paketet
              </Button>
            </>
          ) : (
            <p className="text-ink-muted text-[12px]">Bara ägaren (OWNER) godkänner.</p>
          )}
        </div>
      )}

      {p.status === 'APPROVED' && (
        <div className="space-y-2 rounded-xl border border-gray-100 p-3">
          <h4 className="text-ink text-sm font-semibold">Verkställ (ägaren)</h4>
          {isOwner ? (
            <>
              <p className="text-ink-muted text-[12px]">
                Allt prövas igen i en transaktion. Har något ändrats sedan godkännandet — en
                betalning, ett avtal, anslutningen eller en ny Fortnox-läsning — avbryts
                verkställningen utan effekt och paketet måste prövas på nytt.
              </p>
              <label className="text-ink flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={bekraftVerk}
                  onChange={(e) => setBekraftVerk(e.target.checked)}
                />
                <span>
                  Skapa {p.rows.filter((r) => r.kind === 'RECEIVABLE').length} historiska fordringar
                  och {p.rows.filter((r) => r.kind === 'DEPOSIT').length} historiska depositioner.
                  Inget bokförs, skickas eller exporteras.
                </span>
              </label>
              <Button
                size="sm"
                disabled={!bekraftVerk}
                loading={verkstall.isPending}
                onClick={() => verkstall.mutate()}
              >
                Verkställ paketet
              </Button>
            </>
          ) : (
            <p className="text-ink-muted text-[12px]">Bara ägaren (OWNER) verkställer.</p>
          )}
        </div>
      )}

      {p.status === 'EXECUTED' && (
        <p className="flex items-center gap-1.5 text-sm text-emerald-700">
          <CheckCircle2 size={15} /> Verkställt. Historiska fordringar står som "Historisk skuld"
          och ingår inte i påminnelser eller förfallen skuld.
        </p>
      )}
    </section>
  )
}

function Siffra({ etikett, varde }: { etikett: string; varde: string }) {
  return (
    <div className="min-w-0 rounded-xl bg-gray-50 px-3 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{etikett}</p>
      <p className="text-ink mt-0.5 break-words text-sm font-semibold">{varde}</p>
    </div>
  )
}

function RadLista({ p }: { p: OpeningPackage }) {
  if (p.rows.length === 0)
    return (
      <p className="text-ink-muted text-sm">
        {p.zeroOpening ? 'Nollöppning — inga rader.' : 'Inga rader.'}
      </p>
    )
  const period = (r: OpeningPackage['rows'][number]) =>
    r.kind === 'RECEIVABLE'
      ? `${r.periodYear}-${String(r.periodMonth).padStart(2, '0')}`
      : `mottagen ${r.receivedDate ?? '?'}`
  return (
    <div className="min-w-0">
      <h4 className="text-ink mb-2 text-sm font-semibold">Rader</h4>
      {/* Mobil (390 px): kort per rad. */}
      <ul className="space-y-2 sm:hidden">
        {p.rows.map((r) => (
          <li key={r.id} className="rounded-lg border border-gray-100 p-2 text-[13px]">
            <p className="font-medium">
              {r.rowNo}. {r.kind === 'RECEIVABLE' ? 'Fordran' : 'Deposition'} · {r.openAmount} kr
            </p>
            <p className="text-ink-muted break-words">
              {r.sourceId} · {r.tenantRef} ·{' '}
              {r.leaseRef ?? `${r.propertyRef ?? ''} ${r.unitRef ?? ''}`} · {period(r)}
            </p>
            {(r.errors ?? []).map((e) => (
              <p key={e} className="break-words text-red-700">
                {e}
              </p>
            ))}
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full text-left text-[13px]">
          <thead className="text-[11px] uppercase tracking-wide text-gray-400">
            <tr>
              <th className="py-1 pr-2">#</th>
              <th className="py-1 pr-2">Källrad</th>
              <th className="py-1 pr-2">Typ</th>
              <th className="py-1 pr-2">Hyresgäst</th>
              <th className="py-1 pr-2">Avtal</th>
              <th className="py-1 pr-2">Period</th>
              <th className="py-1 pr-2 text-right">Öppet</th>
              <th className="py-1">Fel</th>
            </tr>
          </thead>
          <tbody>
            {p.rows.map((r) => (
              <tr key={r.id} className="border-t border-gray-100 align-top">
                <td className="py-1 pr-2">{r.rowNo}</td>
                <td className="py-1 pr-2">{r.sourceId}</td>
                <td className="py-1 pr-2">{r.kind === 'RECEIVABLE' ? 'Fordran' : 'Deposition'}</td>
                <td className="break-all py-1 pr-2">{r.tenantRef}</td>
                <td className="py-1 pr-2">
                  {r.leaseRef ?? `${r.propertyRef ?? ''} ${r.unitRef ?? ''}`}
                </td>
                <td className="py-1 pr-2">{period(r)}</td>
                <td className="py-1 pr-2 text-right">{r.openAmount}</td>
                <td className="py-1 text-red-700">{(r.errors ?? []).join(' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
