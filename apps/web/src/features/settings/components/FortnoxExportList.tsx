import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fortnoxExportsPageQuerySchema, type FortnoxExportsPageQuery } from '@eken/shared'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useAuthStore } from '@/stores/auth.store'
import { listFortnoxExportsPage } from '../api/fortnox-export.api'
import { FortnoxExportRowView } from './FortnoxExportRow'

const PAGE_SIZE = 50

export interface FortnoxExportListProps {
  group: NonNullable<FortnoxExportsPageQuery['group']>
  title: string
  sendingEnabled: boolean
  onChanged: () => Promise<void>
  testId?: string
}

export function FortnoxExportList(props: FortnoxExportListProps) {
  const user = useAuthStore((state) => state.user)
  const organization = useAuthStore((state) => state.organization)
  if (!organization?.id || !user?.id || (user.role !== 'OWNER' && user.role !== 'ADMIN')) {
    return null
  }
  const scope = [organization.id, user.id, user.role] as const
  return (
    <FortnoxExportListScoped
      key={JSON.stringify([...scope, props.group])}
      {...props}
      scope={scope}
    />
  )
}

function FortnoxExportListScoped({
  group,
  title,
  sendingEnabled,
  onChanged,
  testId,
  scope,
}: FortnoxExportListProps & { scope: readonly [string, string, string] }) {
  // Även äldre problem ingår från början. Datum begränsar bara på användarens begäran.
  const [query, setQuery] = useState<FortnoxExportsPageQuery>({
    group,
    offset: 0,
    limit: PAGE_SIZE,
  })
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [filterError, setFilterError] = useState<string | null>(null)
  const [reloadingPage, setReloadingPage] = useState(false)
  const exports = useQuery({
    queryKey: ['fortnox', 'exports-page', ...scope, query],
    queryFn: () => listFortnoxExportsPage(query),
    retry: false,
    staleTime: 0,
    // Överskrid även en eventuell global keepPreviousData: varje sida har eget resultat.
    placeholderData: () => undefined,
  })
  const offset = query.offset ?? 0
  const data = exports.isError ? undefined : exports.data
  const lastOffset = data ? Math.max(0, Math.ceil(data.total / PAGE_SIZE) - 1) * PAGE_SIZE : 0
  const outsidePageRange = Boolean(data && offset > lastOffset)
  const inconsistentPage = Boolean(
    data &&
    ((data.items.length === 0 && data.total > 0) || offset + data.items.length > data.total),
  )
  const adjustingPage = !exports.isError && (outsidePageRange || reloadingPage)

  useEffect(() => {
    // En avstämd rad kan lämna gruppen och göra sista sidan tom. Hämta då sista giltiga sidan.
    if (data && offset > lastOffset) {
      setReloadingPage(true)
      setQuery((current) => ({ ...current, offset: lastOffset }))
    } else if (exports.isError || (data && !exports.isFetching)) {
      setReloadingPage(false)
    }
  }, [data, offset, lastOffset, exports.isFetching, exports.isError])

  return (
    <section aria-label={title} data-testid={testId} className="min-w-0 space-y-3">
      <h3 className="text-ink text-sm font-semibold">
        {title}
        {data && !adjustingPage ? ` (${data.total})` : ''}
      </h3>
      {!sendingEnabled && (
        <p className="text-ink-muted text-sm">Sändning till Fortnox är inte aktiverad.</p>
      )}
      <form
        aria-label={`Datumfilter för ${title}`}
        className="min-w-0 space-y-2"
        onSubmit={(event) => {
          event.preventDefault()
          const candidate: FortnoxExportsPageQuery = {
            group,
            offset: 0,
            limit: PAGE_SIZE,
            ...(from ? { from } : {}),
            ...(to ? { to } : {}),
          }
          const parsed = fortnoxExportsPageQuerySchema.safeParse(candidate)
          if (!parsed.success) {
            setFilterError(parsed.error.issues[0]?.message ?? 'Kontrollera perioden.')
            return
          }
          setFilterError(null)
          setReloadingPage(false)
          setQuery(parsed.data)
        }}
      >
        <p className="text-ink-muted text-xs">Datumfiltret gäller verifikationsdatum.</p>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <Input
            type="date"
            label="Från"
            value={from}
            onChange={(event) => {
              setFrom(event.target.value)
              setFilterError(null)
            }}
          />
          <Input
            type="date"
            label="Till"
            value={to}
            onChange={(event) => {
              setTo(event.target.value)
              setFilterError(null)
            }}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm">
            Visa period
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setFrom('')
              setTo('')
              setFilterError(null)
              setReloadingPage(false)
              setQuery({ group, offset: 0, limit: PAGE_SIZE })
            }}
          >
            Alla datum
          </Button>
        </div>
        {filterError && (
          <p role="alert" className="text-sm text-red-700">
            {filterError}
          </p>
        )}
        <p className="text-ink-muted text-xs">
          {query.from || query.to
            ? `Period: ${query.from ?? 'alla tidigare datum'} – ${query.to ?? 'alla senare datum'}.`
            : 'Visar alla datum.'}
        </p>
      </form>

      {(adjustingPage || exports.isFetching) && (
        <p role="status" className="text-ink-muted text-sm">
          {adjustingPage ? 'Urvalet har ändrats. Hämtar aktuell sida…' : 'Hämtar överföringar…'}
        </p>
      )}
      {exports.isError && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-red-700">
            Överföringarna kunde inte läsas.
          </p>
          <Button type="button" size="sm" onClick={() => void exports.refetch()}>
            Försök igen
          </Button>
        </div>
      )}
      {data && !adjustingPage && inconsistentPage && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status" className="text-ink-muted text-sm">
            Urvalet har ändrats. Uppdatera listan för att se aktuell sida.
          </p>
          <Button
            type="button"
            size="sm"
            disabled={exports.isFetching}
            onClick={() => void exports.refetch()}
          >
            Uppdatera listan
          </Button>
        </div>
      )}
      {data && !adjustingPage && !inconsistentPage && (
        <>
          <p role="status" className="text-ink-muted text-sm">
            Visar {data.items.length ? offset + 1 : 0}–
            {data.items.length ? offset + data.items.length : 0} av {data.total} överföringar.
          </p>
          {data.total === 0 ? (
            <p className="text-ink-muted text-sm">
              {group === 'NEEDS_REVIEW'
                ? 'Inget att stämma av i urvalet.'
                : 'Inga överföringar i urvalet.'}
            </p>
          ) : (
            <ul className="space-y-1 text-sm">
              {data.items.map((row) => (
                <FortnoxExportRowView
                  key={row.id}
                  row={row}
                  sendingEnabled={sendingEnabled}
                  onChanged={onChanged}
                />
              ))}
            </ul>
          )}
        </>
      )}
      <nav aria-label={`Sidor i ${title}`} className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={!data || adjustingPage || exports.isFetching || offset === 0}
          onClick={() =>
            setQuery((current) => ({ ...current, offset: Math.max(0, offset - PAGE_SIZE) }))
          }
        >
          Föregående
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!data || adjustingPage || exports.isFetching || offset >= lastOffset}
          onClick={() => setQuery((current) => ({ ...current, offset: offset + PAGE_SIZE }))}
        >
          Nästa
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!data || adjustingPage || exports.isFetching || offset >= lastOffset}
          onClick={() => setQuery((current) => ({ ...current, offset: lastOffset }))}
        >
          Sista sidan
        </Button>
      </nav>
    </section>
  )
}
