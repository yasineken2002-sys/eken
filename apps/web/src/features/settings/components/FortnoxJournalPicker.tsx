import { useEffect, useRef, useState } from 'react'
import { onlineManager, useMutation, useQuery } from '@tanstack/react-query'
import {
  JOURNAL_SOURCES,
  journalPageQuerySchema,
  fortnoxDryRunInputSchema,
  type JournalEntry,
  type JournalPageQuery,
  type FortnoxDryRunInput,
} from '@eken/shared'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { extractApiError } from '@/lib/api'
import { kontraktsfel } from '@/lib/contract-gate'
import { useAuthStore } from '@/stores/auth.store'
import { fetchJournalPage } from '../../accounting/api/accounting.api'
import { startFortnoxDryRun, type FortnoxExportRow } from '../api/fortnox-export.api'
import { FortnoxExportTextView } from './FortnoxExportRow'
import { EXPORT_STATE_TEXT } from './fortnox-export-text'

const PAGE_SIZE = 50
const SOURCE_TEXT: Record<NonNullable<JournalPageQuery['source']>, string> = {
  MANUAL: 'Manuell',
  AI: 'AI',
  INVOICE: 'Kundfaktura',
  PAYMENT: 'Betalning',
  LEASE: 'Hyresavtal',
  RENT_NOTICE: 'Hyresavi',
  MISC_CHARGE: 'Övrig debitering',
  SUPPLIER_INVOICE: 'Leverantörsfaktura',
}
interface Props {
  onChanged: () => Promise<void>
}

function currentScope(scope: readonly string[]) {
  const { user, organization } = useAuthStore.getState()
  return organization?.id === scope[0] && user?.id === scope[1] && user?.role === scope[2]
}

function requireNetwork() {
  if (!onlineManager.isOnline() || !navigator.onLine) {
    throw new Error('Du är offline. Anslut till internet och försök igen.')
  }
}

/** Monteras av Setup först när Fortnox-anslutningen är aktiv. */
export function FortnoxJournalPicker(props: Props) {
  const user = useAuthStore((s) => s.user)
  const org = useAuthStore((s) => s.organization)
  if (!user?.id || !org?.id || (user.role !== 'OWNER' && user.role !== 'ADMIN')) return null
  const scope = [org.id, user.id, user.role] as const
  return <JournalPickerScoped key={JSON.stringify(scope)} {...props} scope={scope} />
}

function JournalPickerScoped({ onChanged, scope }: Props & { scope: readonly string[] }) {
  const [query, setQuery] = useState<JournalPageQuery>({ offset: 0, limit: PAGE_SIZE })
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [source, setSource] = useState<NonNullable<JournalPageQuery['source']> | ''>('')
  const [error, setError] = useState<string | null>(null)
  const [selectionVersion, setSelectionVersion] = useState(0)
  const entries = useQuery({
    // Behåller huvudbokens invalidationsprefix, med separat sida och behörighetsscope.
    queryKey: ['accounting', 'journal', 'fortnox-picker', ...scope, query],
    queryFn: ({ signal }) => {
      requireNetwork()
      if (!currentScope(scope)) throw new Error('Kontot har ändrats. Hämta urvalet igen.')
      return fetchJournalPage({ ...query, offset: query.offset ?? 0, limit: PAGE_SIZE }, signal)
    },
    networkMode: 'always',
    meta: { handlesOwnError: true },
    retry: false,
    staleTime: 0,
    placeholderData: () => undefined,
  })
  const offset = query.offset ?? 0
  const data = entries.isError || entries.isFetching ? undefined : entries.data
  const lastOffset = data ? Math.max(0, Math.ceil(data.total / PAGE_SIZE) - 1) * PAGE_SIZE : 0
  const outside = Boolean(data && offset > lastOffset)
  const inconsistent = Boolean(
    data &&
    (data.offset !== offset ||
      data.limit !== PAGE_SIZE ||
      (data.entries.length === 0 && data.total > 0) ||
      offset + data.entries.length > data.total),
  )
  const unapplied =
    from !== (query.from ?? '') || to !== (query.to ?? '') || source !== (query.source ?? '')
  const ready = Boolean(data && !outside && !inconsistent && !unapplied)

  function clearSelection() {
    setSelectionVersion((value) => value + 1)
  }
  function showQuery(next: JournalPageQuery) {
    clearSelection()
    setQuery(next)
  }
  useEffect(() => {
    if (data && offset > lastOffset) {
      setSelectionVersion((value) => value + 1)
      setQuery((current) => ({ ...current, offset: lastOffset }))
    }
  }, [data, offset, lastOffset])

  return (
    <section aria-label="Välj verifikat för förhandskontroll" className="min-w-0 space-y-3">
      <h4 className="text-ink text-sm font-semibold">3. Förhandskontrollera ett verifikat</h4>
      <form
        className="min-w-0 space-y-2"
        onSubmit={(event) => {
          event.preventDefault()
          const candidate: JournalPageQuery = {
            offset: 0,
            limit: PAGE_SIZE,
            ...(from ? { from } : {}),
            ...(to ? { to } : {}),
            ...(source ? { source } : {}),
          }
          const parsed = journalPageQuerySchema.safeParse(candidate)
          if (!parsed.success) {
            setError(parsed.error.issues[0]?.message ?? 'Kontrollera urvalet.')
            return
          }
          setError(null)
          showQuery(parsed.data)
        }}
      >
        <p className="text-ink-muted text-xs">
          Välj bland alla datum, eller begränsa med verifikationsdatum och källa.
        </p>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <Input
            type="date"
            label="Verifikationsdatum från"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value)
              setError(null)
              clearSelection()
            }}
          />
          <Input
            type="date"
            label="Verifikationsdatum till"
            value={to}
            onChange={(event) => {
              setTo(event.target.value)
              setError(null)
              clearSelection()
            }}
          />
        </div>
        <Select
          label="Källa"
          value={source}
          options={[
            { value: '', label: 'Alla källor' },
            ...JOURNAL_SOURCES.map((value) => ({ value, label: SOURCE_TEXT[value] })),
          ]}
          onChange={(event) => {
            setSource(JOURNAL_SOURCES.find((value) => value === event.target.value) ?? '')
            setError(null)
            clearSelection()
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm">
            Visa urval
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setFrom('')
              setTo('')
              setError(null)
              showQuery({ offset: 0, limit: PAGE_SIZE, ...(source ? { source } : {}) })
            }}
          >
            Alla datum
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        )}
        {unapplied && (
          <p className="text-ink-muted text-xs">Tryck på Visa urval för att använda filtren.</p>
        )}
      </form>
      {(entries.isFetching || outside) && (
        <p role="status" className="text-ink-muted text-sm">
          Hämtar verifikat…
        </p>
      )}
      {entries.isError && (
        <p role="alert" className="text-sm text-red-700">
          {extractApiError(entries.error, 'Verifikaten kunde inte hämtas.')}
        </p>
      )}
      {inconsistent && !outside && (
        <p role="status" className="text-ink-muted text-sm">
          Urvalet har ändrats. Uppdatera listan för att se aktuell sida.
        </p>
      )}
      {(entries.isError || (inconsistent && !outside)) && (
        <Button
          type="button"
          size="sm"
          onClick={() => {
            clearSelection()
            void entries.refetch()
          }}
        >
          Försök igen
        </Button>
      )}
      {data && !outside && !inconsistent && (
        <p role="status" className="text-ink-muted text-xs">
          Visar {data.entries.length ? offset + 1 : 0}–
          {data.entries.length ? offset + data.entries.length : 0} av {data.total} verifikat
        </p>
      )}
      {data?.total === 0 && !outside && !inconsistent && (
        <p className="text-ink-muted text-sm">Inga verifikat i urvalet.</p>
      )}
      <JournalSelection
        key={selectionVersion}
        rows={ready ? data!.entries : []}
        ready={ready}
        onChanged={onChanged}
        scope={scope}
      />
      <nav aria-label="Sidor med verifikat" className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!ready || offset === 0}
          onClick={() => showQuery({ ...query, offset: Math.max(0, offset - PAGE_SIZE) })}
        >
          Föregående
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!ready || offset >= lastOffset}
          onClick={() => showQuery({ ...query, offset: offset + PAGE_SIZE })}
        >
          Nästa
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!ready || offset >= lastOffset}
          onClick={() => showQuery({ ...query, offset: lastOffset })}
        >
          Sista sidan
        </Button>
      </nav>
    </section>
  )
}

function JournalSelection({
  rows,
  ready,
  onChanged,
  scope,
}: Props & { rows: JournalEntry[]; ready: boolean; scope: readonly string[] }) {
  const [entryId, setEntryId] = useState('')
  const [result, setResult] = useState<FortnoxExportRow | null>(null)
  const [error, setError] = useState<string | null>(null)
  const attempt = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      attempt.current += 1
    }
  }, [])
  useEffect(() => {
    if (!ready) {
      attempt.current += 1
      setEntryId('')
      setResult(null)
      setError(null)
    }
  }, [ready])
  const dryRun = useMutation({
    mutationFn: ({ body, attemptId }: { body: FortnoxDryRunInput; attemptId: number }) => {
      requireNetwork()
      if (!mounted.current || attemptId !== attempt.current || !currentScope(scope)) {
        throw new Error('Urvalet har ändrats. Välj verifikat igen.')
      }
      return startFortnoxDryRun(body)
    },
    networkMode: 'always',
    meta: { handlesOwnError: true },
    retry: false,
    onSuccess: async (row, requested) => {
      if (!mounted.current || requested.attemptId !== attempt.current || !currentScope(scope))
        return
      if (row.journalEntryId === requested.body.journalEntryId) setResult(row)
      await onChanged()
    },
    onError: (failure, requested) => {
      if (!mounted.current || requested.attemptId !== attempt.current || !currentScope(scope))
        return
      setError(extractApiError(failure))
    },
  })
  const selected = ready && rows.some((row) => row.id === entryId)
  return (
    <div className="min-w-0 space-y-2">
      <Select
        label="Verifikat"
        value={selected ? entryId : ''}
        disabled={!ready || dryRun.isPending}
        options={[
          { value: '', label: ready ? 'Välj verifikat' : 'Inväntar aktuellt urval…' },
          ...rows.map((row) => ({
            value: row.id,
            label: `${row.series ?? ''}${row.verNumber ?? ''} · ${row.date.slice(0, 10)} · ${row.description}`,
          })),
        ]}
        onChange={(event) => {
          attempt.current += 1
          setEntryId(event.target.value)
          setResult(null)
          setError(null)
          dryRun.reset()
        }}
      />
      <Button
        type="button"
        size="sm"
        variant="primary"
        disabled={!selected || dryRun.isPending}
        onClick={() => {
          if (!selected || !currentScope(scope)) return
          try {
            requireNetwork()
          } catch (failure) {
            setError(extractApiError(failure))
            return
          }
          const body: FortnoxDryRunInput = { journalEntryId: entryId }
          const message = kontraktsfel(fortnoxDryRunInputSchema, body)
          if (message) {
            setError(message)
            return
          }
          setError(null)
          setResult(null)
          dryRun.mutate({ body, attemptId: ++attempt.current })
        }}
      >
        {dryRun.isPending ? 'Kontrollerar…' : 'Förhandskontrollera'}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {selected && result?.journalEntryId === entryId && (
        <div
          role="status"
          data-testid="fortnox-dry-run-result"
          className="border-line rounded-lg border p-3 text-sm"
        >
          <p className="text-ink font-medium">{EXPORT_STATE_TEXT[result.state]}</p>
          {result.blockReason && (
            <p className="text-ink-muted break-words">Skäl: {result.blockReason}</p>
          )}
          <FortnoxExportTextView items={result.exportText} />
        </div>
      )}
    </div>
  )
}
