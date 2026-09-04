import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  AlertCircle,
  ArrowLeft,
  Building2,
  CheckCircle2,
  Landmark,
  Link2,
  Link2Off,
  RefreshCw,
} from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { StatCard } from '@/components/ui/StatCard'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadErrorState } from '@/components/ui/LoadErrorState'
import { PermissionDeniedState } from '@/components/ui/PermissionDeniedState'
import { BankConsentStatusBadge } from './components/BankConsentStatusBadge'
import {
  useBankConsents,
  useBeginBankConsent,
  useRevokeBankConsent,
  useSyncBank,
  synkBaslinje,
  synkLage,
} from './hooks/usePsd2'
import { aktivaSamtycken, consentDisplayFields, tolkaPsd2Kvittens } from './api/psd2.api'
import type { BankConsent, ConsentVisning, Psd2Kvittens } from './api/psd2.api'
import { extractApiError, isForbidden, isUnavailable } from '@/lib/api'
import { useCurrentRole } from '@/hooks/useCanWrite'

/**
 * BANKKOPPLING (PSD2) — samtycke, synk och återkallelse.
 *
 * ── VARFÖR SIDAN LIGGER PÅ /reconciliation/settings ─────────────────────────
 *
 * Adressen är inte vald här. `PSD2_APP_RETURN_URL` defaultar till
 * `…/reconciliation/settings` i `psd2-consent.service.ts`, och det är dit banken
 * skickar tillbaka användaren efter SCA. Rutten fanns inte när backend skrevs, så
 * en lyckad callback landade på catch-all-sidan. Att i stället ändra defaulten
 * hade flyttat problemet till varje redan satt `PSD2_APP_RETURN_URL`.
 *
 * ── VARFÖR ROLLKONTROLLEN INTE ÄR useCanWrite ───────────────────────────────
 *
 * `useCanWrite` är MANAGER och uppåt. PSD2-endpointsen bär `@Roles('OWNER',
 * 'ADMIN')` — bindande bankåtkomst är inte en förvaltningsåtgärd. En MANAGER som
 * fick knapparna hade mötts av 403 på klick, alltså en knapp som ser trasig ut i
 * stället för en som inte finns. `useCanDelete` har rätt mängd men fel namn för
 * det här; villkoret skrivs därför ut i klartext nedan.
 */
const BANK_ROLLER = ['OWNER', 'ADMIN']

interface KvittensProps {
  kvittens: Psd2Kvittens
  onStang: () => void
}

function KvittensPanel({ kvittens, onStang }: KvittensProps) {
  if (!kvittens) return null
  const ok = kvittens === 'ok'
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={
        ok
          ? 'mt-6 flex items-start gap-3 rounded-2xl border border-emerald-100 bg-emerald-50 p-4'
          : 'mt-6 flex items-start gap-3 rounded-2xl border border-red-100 bg-red-50 p-4'
      }
    >
      {ok ? (
        <CheckCircle2
          size={18}
          strokeWidth={1.8}
          className="mt-0.5 flex-shrink-0 text-emerald-600"
        />
      ) : (
        <AlertCircle size={18} strokeWidth={1.8} className="mt-0.5 flex-shrink-0 text-red-500" />
      )}
      <div className="flex-1">
        <p
          className={
            ok
              ? 'text-[13.5px] font-medium text-emerald-800'
              : 'text-[13.5px] font-medium text-red-700'
          }
        >
          {ok ? 'Banken är ansluten' : 'Anslutningen slutfördes inte'}
        </p>
        <p
          className={ok ? 'mt-0.5 text-[13px] text-emerald-700' : 'mt-0.5 text-[13px] text-red-600'}
        >
          {ok
            ? 'Samtycket är registrerat. Transaktioner hämtas vid nästa synk.'
            : 'Banken avbröt eller nekade samtycket, eller så hann det gå ut. Försök ansluta igen.'}
        </p>
      </div>
      <Button variant="ghost" size="xs" onClick={onStang}>
        Stäng
      </Button>
    </motion.div>
  )
}

function ConsentKort({
  visning,
  kanAndra,
  onAterkalla,
  index,
}: {
  visning: ConsentVisning
  kanAndra: boolean
  onAterkalla: () => void
  index: number
}) {
  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: 8 },
        show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
      }}
      whileHover={{ y: -2, boxShadow: '0 8px 24px rgba(0,0,0,0.08)' }}
      className="border-line bg-surface rounded-2xl border p-5 transition-shadow"
      data-testid={`bank-consent-${index}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-gray-100 bg-gray-50">
            <Landmark size={16} strokeWidth={1.8} className="text-gray-500" />
          </div>
          <div>
            <p className="text-[13.5px] font-medium text-gray-900">{visning.provider}</p>
            <p className="text-[12px] text-gray-400">Bankkoppling</p>
          </div>
        </div>
        <BankConsentStatusBadge status={visning.status} />
      </div>

      <dl className="mt-4 space-y-1.5">
        {visning.rader.map((rad) => (
          <div key={rad.etikett} className="flex items-baseline justify-between gap-4">
            <dt className="text-[12px] text-gray-400">{rad.etikett}</dt>
            <dd className="text-[13px] text-gray-700">{rad.varde}</dd>
          </div>
        ))}
      </dl>

      {kanAndra && visning.status !== 'REVOKED' && (
        <div className="border-line mt-4 flex justify-end border-t pt-4">
          <Button variant="ghost" size="sm" onClick={onAterkalla}>
            <Link2Off size={14} strokeWidth={1.8} />
            Återkalla
          </Button>
        </div>
      )}
    </motion.div>
  )
}

/**
 * `psd2` kommer från rutten (`validateSearch` i router.tsx), inte från
 * `window.location`. Skälet är TanStack Routers egen modell: sök-parametrar är
 * en del av rutten och läses typat, och en komponent som går runt routern kan
 * inte städa bort parametern genom den heller.
 */
export function BankConnectionPage({ psd2 }: { psd2?: string | undefined }) {
  const navigate = useNavigate()
  const roll = useCurrentRole()
  const kanAndra = roll !== undefined && BANK_ROLLER.includes(roll)

  const [kvittens, setKvittens] = useState<Psd2Kvittens>(null)
  const [aterkallar, setAterkallar] = useState<ConsentVisning | null>(null)
  const [synkStartad, setSynkStartad] = useState<number | null>(null)
  const [synkBesked, setSynkBesked] = useState<string | null>(null)
  const [fel, setFel] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const baslinje = useRef<Map<string, string | null>>(new Map())

  // Kvittensen läses EN gång och plockas sedan bort ur URL:en. Annars hade en
  // omladdning — eller ett bokmärke — visat "Banken är ansluten" om en
  // anslutning som skedde för en vecka sedan.
  useEffect(() => {
    const tolkad = tolkaPsd2Kvittens(psd2)
    if (!tolkad) return
    setKvittens(tolkad)
    void navigate({ to: '/reconciliation/settings', search: {}, replace: true })
  }, [psd2, navigate])

  const pollar = synkStartad !== null
  const {
    data: consents = [],
    isLoading,
    isError: felade,
    error,
    refetch,
  } = useBankConsents(pollar)

  const nekad = isForbidden(error)
  const haveri = felade && !nekad

  const beginMutation = useBeginBankConsent()
  const revokeMutation = useRevokeBankConsent()
  const syncMutation = useSyncBank()

  // Pollningen avslutas av en FLYTTAD lastSyncedAt, inte av att jobbet lades i
  // kön. Se `synkLage` för varför uppgivet inte är samma sak som misslyckat.
  useEffect(() => {
    if (synkStartad === null) return
    const lage = synkLage({
      baslinje: baslinje.current,
      nu: consents,
      forflutenMs: Date.now() - synkStartad,
    })
    if (lage === 'pagar') return
    setSynkStartad(null)
    setSynkBesked(
      lage === 'klar'
        ? 'Synken är klar. Nya transaktioner finns i bankavstämningen.'
        : 'Synken pågår fortfarande — kom tillbaka om en stund.',
    )
    // `tick` står i beroendelistan just för att den ska driva utvärderingen —
    // den läses medvetet inte i kroppen.
  }, [consents, synkStartad, tick])

  // TICKEN ÄR INTE DEKORATION. Utvärderingen ovan körs bara när `consents` byter
  // referens, alltså när en hämtning faktiskt gav ny data. Står allt still —
  // vilket är precis vad som händer när jobbet ligger kvar i kön — hade
  // `uppgiven` aldrig kunnat inträffa, och knappen förblivit "Synkar…" i
  // evighet. En räknare som ökar tvingar fram utvärderingen även vid oförändrad
  // lista.
  //
  // (Ett `setSynkStartad(s => s)` hade inte fungerat: React avbryter en
  // omrendering när nästa state är identiskt med det förra.)
  useEffect(() => {
    if (synkStartad === null) return
    const id = setInterval(() => setTick((t) => t + 1), 2_000)
    return () => clearInterval(id)
  }, [synkStartad])

  const visningar = useMemo(() => consents.map(consentDisplayFields), [consents])
  const aktiva = aktivaSamtycken(consents)
  const senastSynkad = senasteSynk(consents)

  const felmeddelande = (err: unknown, fallback: string) =>
    isUnavailable(err)
      ? 'Bankkopplingen är inte aktiverad i den här miljön. Den kräver ett aggregatoravtal och slås på av PSD2_ENABLED.'
      : extractApiError(err, fallback)

  const anslut = () => {
    setFel(null)
    beginMutation.mutate(undefined, {
      onSuccess: (data) => {
        // Bankens SCA sker på bankens egen domän — därför en helsidesnavigering
        // och inte en fetch. Vi kommer tillbaka via callbacken.
        window.location.assign(data.authUrl)
      },
      onError: (err) => setFel(felmeddelande(err, 'Kunde inte starta bankanslutningen')),
    })
  }

  const synka = () => {
    setFel(null)
    setSynkBesked(null)
    baslinje.current = synkBaslinje(consents)
    syncMutation.mutate(undefined, {
      onSuccess: () => setSynkStartad(Date.now()),
      onError: (err) => setFel(felmeddelande(err, 'Kunde inte starta synken')),
    })
  }

  const bekraftaAterkallelse = () => {
    if (!aterkallar) return
    setFel(null)
    revokeMutation.mutate(aterkallar.id, {
      onSuccess: () => setAterkallar(null),
      onError: (err) => setFel(felmeddelande(err, 'Kunde inte återkalla samtycket')),
    })
  }

  return (
    <PageWrapper id="bank-connection">
      <PageHeader
        title="Bankkoppling"
        description="Hämta banktransaktioner automatiskt i stället för att importera filer."
        action={
          kanAndra ? (
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={synka}
                disabled={syncMutation.isPending || pollar || aktiva === 0}
              >
                <RefreshCw
                  size={14}
                  strokeWidth={1.8}
                  className={pollar ? 'animate-spin' : undefined}
                />
                {pollar ? 'Synkar…' : 'Synka nu'}
              </Button>
              <Button variant="primary" onClick={anslut} disabled={beginMutation.isPending}>
                <Link2 size={14} strokeWidth={1.8} />
                Anslut bank
              </Button>
            </div>
          ) : undefined
        }
      />

      <KvittensPanel kvittens={kvittens} onStang={() => setKvittens(null)} />

      {nekad ? (
        <div className="mt-6">
          <PermissionDeniedState vad="bankkopplingen" />
        </div>
      ) : haveri ? (
        <div className="mt-6">
          <LoadErrorState vad="bankkopplingen" onRetry={() => void refetch()} />
        </div>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <StatCard title="Anslutna banker" value={consents.length} icon={Landmark} />
            <StatCard title="Aktiva samtycken" value={aktiva} icon={CheckCircle2} delay={0.05} />
            <StatCard
              title="Senast synkad"
              value={senastSynkad ?? 'Aldrig'}
              icon={RefreshCw}
              delay={0.1}
            />
          </div>

          {(fel ?? synkBesked) && (
            <div className="mt-4">
              <p
                className={
                  fel
                    ? 'rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] text-red-600'
                    : 'rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 text-[13px] text-gray-600'
                }
              >
                {fel ?? synkBesked}
              </p>
            </div>
          )}

          {isLoading ? (
            <p className="mt-6 text-[13px] text-gray-400">Hämtar bankkopplingar…</p>
          ) : visningar.length === 0 ? (
            <EmptyState
              icon={Building2}
              title="Ingen bank ansluten"
              description="Anslut din bank så hämtas transaktionerna automatiskt till bankavstämningen."
              action={
                kanAndra ? (
                  <Button variant="primary" onClick={anslut}>
                    <Link2 size={14} strokeWidth={1.8} />
                    Anslut bank
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <motion.div
              variants={{ hidden: {}, show: { transition: { staggerChildren: 0.05 } } }}
              initial="hidden"
              animate="show"
              className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
            >
              {visningar.map((visning, i) => (
                <ConsentKort
                  key={visning.id}
                  visning={visning}
                  index={i}
                  kanAndra={kanAndra}
                  onAterkalla={() => setAterkallar(visning)}
                />
              ))}
            </motion.div>
          )}

          <div className="mt-8">
            <Link
              to="/reconciliation"
              className="inline-flex items-center gap-1.5 text-[13px] text-gray-500 hover:text-gray-700"
            >
              <ArrowLeft size={14} strokeWidth={1.8} />
              Till bankavstämningen
            </Link>
          </div>
        </>
      )}

      <Modal
        open={aterkallar !== null}
        onClose={() => setAterkallar(null)}
        title="Återkalla bankkoppling"
        description="Inflödet av transaktioner upphör. Redan importerade transaktioner och bokföring påverkas inte."
      >
        <p className="text-[13px] leading-relaxed text-gray-600">
          Samtycket hos {aterkallar?.provider} återkallas och de sparade bank-tokens raderas. För
          att hämta transaktioner igen måste du ansluta banken på nytt och legitimera dig hos
          banken.
        </p>
        <ModalFooter>
          <Button variant="secondary" onClick={() => setAterkallar(null)}>
            Avbryt
          </Button>
          <Button
            variant="danger"
            onClick={bekraftaAterkallelse}
            disabled={revokeMutation.isPending}
          >
            {revokeMutation.isPending ? 'Återkallar…' : 'Återkalla'}
          </Button>
        </ModalFooter>
      </Modal>
    </PageWrapper>
  )
}

function senasteSynk(consents: readonly BankConsent[]): string | null {
  const tider = consents
    .map((c) => c.lastSyncedAt)
    .filter((v): v is string => typeof v === 'string')
    .map((v) => new Date(v))
    .filter((d) => !Number.isNaN(d.getTime()))
  if (tider.length === 0) return null
  const senast = tider.reduce((a, b) => (a > b ? a : b))
  return senast.toLocaleDateString('sv-SE')
}
