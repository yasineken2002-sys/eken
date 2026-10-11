import { useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { Button } from '@/components/ui/Button'
import { Input, Select } from '@/components/ui/Input'
import { isForbidden } from '@/lib/api'
import { useFortnoxCatalog } from '../hooks/useFortnoxCatalog'
import { buildMappingSelection, buildReadSelection, dimensionKey } from './fortnox-selection'

export function FortnoxReadSetup({
  companyNumber,
  blocked,
  onAccessDenied,
}: {
  companyNumber: number
  blocked: boolean
  onAccessDenied: () => void
}) {
  const [yearId, setYearId] = useState<number | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [accounts, setAccounts] = useState<number[]>([])
  const [selectedDimension, setSelectedDimension] = useState('')
  const [propertyId, setPropertyId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const dispatching = useRef(false)
  const { catalog, properties, read, mapping, organizationId } = useFortnoxCatalog(
    yearId,
    companyNumber,
  )
  const denied = [catalog.error, properties.error, read.error, mapping.error].some(isForbidden)
  useEffect(() => {
    if (denied) onAccessDenied()
  }, [denied, onAccessDenied])
  const data = catalog.data
  const catalogSafe = Boolean(
    data?.ready && data.complete && data.company.databaseNumber === companyNumber,
  )
  const busy = blocked || read.isPending || mapping.isPending
  const locked = busy || catalog.isFetching || catalog.isError || !catalogSafe || needsRefresh
  const ownProperties = (properties.data ?? []).filter(
    (property) => property.organizationId === organizationId,
  )
  const year = data?.financialYears.find((item) => item.id === yearId)
  let readProblem: string | null = null
  let mappingProblem: string | null = null
  try {
    if (data) buildReadSelection(data, companyNumber, { yearId, from, to, accounts })
    else readProblem = 'Invänta katalogen.'
  } catch (problem) {
    readProblem = problem instanceof Error ? problem.message : 'Kontrollera urvalet.'
  }
  try {
    if (data && organizationId)
      buildMappingSelection(
        data,
        companyNumber,
        { dimensionKey: selectedDimension, propertyId },
        ownProperties,
        organizationId,
      )
    else mappingProblem = 'Invänta katalogen.'
  } catch (problem) {
    mappingProblem = problem instanceof Error ? problem.message : 'Kontrollera kopplingen.'
  }

  const refresh = async () => {
    if (busy) return
    setAccounts([])
    setSelectedDimension('')
    setPropertyId('')
    setNotice(null)
    const result = await catalog.refetch()
    if (
      result.isSuccess &&
      result.data.ready &&
      result.data.complete &&
      result.data.company.databaseNumber === companyNumber
    ) {
      setNeedsRefresh(false)
      setError(null)
    }
    void properties.refetch()
  }
  const fail = (problem: unknown, fallback: string) => {
    setNeedsRefresh(true)
    setError(
      axios.isAxiosError(problem) && problem.response?.status === 409
        ? 'Urvalet har ändrats sedan det hämtades. Hämta om valen och välj på nytt.'
        : fallback,
    )
  }
  const submitRead = async (event: React.FormEvent) => {
    event.preventDefault()
    if (locked || readProblem || !data || dispatching.current) return
    dispatching.current = true
    setError(null)
    setNotice(null)
    try {
      const result = await read.mutateAsync(
        buildReadSelection(data, companyNumber, { yearId, from, to, accounts }),
      )
      setNotice(
        result.status === 'RUNNING'
          ? 'Läsningen pågår. Följ det senaste läsförsöket.'
          : result.status === 'COMPLETE' || result.status === 'COMPLETE_WITH_UNCERTAINTY'
            ? 'Läsningen är slutförd. Kontrollera underlagets period, konton och eventuella osäkerheter.'
            : 'Läsningen blev inte komplett. Ingen aktuell summa finns; se senaste läsförsöket.',
      )
    } catch (problem) {
      fail(
        problem,
        'Läsningen kunde inte bekräftas. Hämta om valen och kontrollera senaste läsförsöket innan du försöker igen.',
      )
    } finally {
      dispatching.current = false
    }
  }
  const submitMapping = async (event: React.FormEvent) => {
    event.preventDefault()
    if (
      locked ||
      properties.isFetching ||
      properties.isError ||
      mappingProblem ||
      !data ||
      !organizationId ||
      dispatching.current
    )
      return
    dispatching.current = true
    setError(null)
    setNotice(null)
    try {
      await mapping.mutateAsync(
        buildMappingSelection(
          data,
          companyNumber,
          { dimensionKey: selectedDimension, propertyId },
          ownProperties,
          organizationId,
        ),
      )
      setNotice(
        'Fastighetskopplingen är sparad. Gör en ny läsning för att använda den; tidigare underlag räknas inte om.',
      )
    } catch (problem) {
      fail(problem, 'Fastighetskopplingen kunde inte bekräftas. Hämta om valen och försök igen.')
    } finally {
      dispatching.current = false
    }
  }

  if (denied) return null
  return (
    <section
      aria-labelledby="fortnox-selection"
      className="border-line min-w-0 space-y-4 rounded-xl border p-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="fortnox-selection" className="text-ink font-semibold">
            Välj underlag att läsa
          </h3>
          <p className="text-ink-muted mt-1 text-sm">
            Välj räkenskapsår, period och konton från Fortnox.
          </p>
        </div>
        <Button size="sm" disabled={busy || catalog.isFetching} onClick={() => void refresh()}>
          Hämta om valen
        </Button>
      </header>
      {catalog.isLoading ? (
        <p role="status" className="text-ink-muted text-sm">
          Hämtar verifierade år, konton och dimensioner…
        </p>
      ) : catalog.isError ? (
        <p role="alert" className="text-sm text-red-600">
          Katalogen kunde inte hämtas. Hämta om valen för att försöka igen.
        </p>
      ) : !data ? (
        <p role="alert" className="text-ink-muted text-sm">
          Verifierad katalog saknas. Hämta om valen.
        </p>
      ) : !catalogSafe ? (
        <p role="alert" className="text-sm text-amber-600">
          {data.company.databaseNumber !== companyNumber
            ? 'Företaget i katalogen stämmer inte med anslutningen.'
            : (data.reason ?? 'Katalogen är inte komplett. Hämta om valen innan du fortsätter.')}
        </p>
      ) : (
        <>
          <p className="text-ink-muted break-words text-xs">
            Katalog hämtad:{' '}
            {new Date(data.observedAt).toLocaleString('sv-SE', {
              timeZone: 'Europe/Stockholm',
            })}
            . Valen kontrolleras igen när du läser eller sparar.
          </p>
          <form
            onSubmit={(event) => void submitRead(event)}
            className="min-w-0 space-y-4"
            aria-label="Läs valt underlag"
          >
            <fieldset disabled={locked} className="min-w-0 space-y-4">
              <Select
                label="Räkenskapsår"
                value={yearId === null ? '' : String(yearId)}
                options={[
                  { value: '', label: 'Välj räkenskapsår' },
                  ...data.financialYears.map((item) => ({
                    value: String(item.id),
                    label: `${item.from} – ${item.to}`,
                  })),
                ]}
                onChange={(event) => {
                  const selected = data.financialYears.find(
                    (item) => String(item.id) === event.target.value,
                  )
                  setYearId(selected?.id ?? null)
                  setFrom(selected?.from ?? '')
                  setTo(selected?.to ?? '')
                  setAccounts([])
                  setError(null)
                  setNotice(null)
                }}
              />
              {data.financialYears.length === 0 && (
                <p className="text-ink-muted text-sm">
                  Fortnox-företaget har inga räkenskapsår ännu. Lägg upp räkenskapsåret i Fortnox
                  och hämta sedan om valen här. Katalogen är komplett — det finns helt enkelt inget
                  att välja.
                </p>
              )}
              <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                <Input
                  type="date"
                  label="Från och med"
                  value={from}
                  min={year?.from}
                  max={year?.to}
                  disabled={!year}
                  onChange={(event) => setFrom(event.target.value)}
                />
                <Input
                  type="date"
                  label="Till och med"
                  value={to}
                  min={year?.from}
                  max={year?.to}
                  disabled={!year}
                  onChange={(event) => setTo(event.target.value)}
                />
              </div>
              <fieldset
                className="min-w-0 space-y-2"
                disabled={!year || data.selectedFinancialYearId !== yearId}
              >
                <legend className="text-ink mb-2 text-sm font-medium">Konton att läsa</legend>
                {!year ? (
                  <p className="text-ink-muted text-sm">Välj år för att hämta konton.</p>
                ) : data.selectedFinancialYearId !== yearId ? (
                  <p className="text-ink-muted text-sm">
                    Konton för det valda året saknas. Hämta om valen.
                  </p>
                ) : data.costAccounts.length === 0 ? (
                  <p className="text-ink-muted text-sm">
                    Inga verifierade konton finns för det valda året.
                  </p>
                ) : (
                  <div className="border-line max-h-64 space-y-2 overflow-y-auto rounded-lg border p-3">
                    {data.costAccounts.map((account) => (
                      <label
                        key={account.number}
                        className="text-ink flex min-w-0 items-start gap-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          className="mt-1 shrink-0"
                          value={account.number}
                          checked={accounts.includes(account.number)}
                          disabled={!account.selectable}
                          onChange={(event) =>
                            setAccounts((current) =>
                              event.target.checked
                                ? [...current, account.number]
                                : current.filter((number) => number !== account.number),
                            )
                          }
                        />
                        <span className="min-w-0 break-words">
                          {account.number} {account.name}
                          {!account.selectable && (
                            <span className="text-ink-muted block text-xs">
                              {account.reason ?? 'Kan inte väljas'}
                            </span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>
              <p className="text-ink-muted text-xs">
                Måttet är nettobelopp för valda konton. Kontourvalet är en delmängd av huvudboken
                och ger inte i sig företagets resultat.
              </p>
              {readProblem && yearId !== null && (
                <p className="text-ink-muted text-sm">{readProblem}</p>
              )}
              <Button type="submit" variant="primary" disabled={locked || Boolean(readProblem)}>
                {read.isPending ? 'Läser underlag…' : 'Läs valt underlag'}
              </Button>
            </fieldset>
          </form>
          <form
            onSubmit={(event) => void submitMapping(event)}
            aria-label="Koppla dimension till fastighet"
            className="border-line min-w-0 space-y-3 border-t pt-4"
          >
            <h4 className="text-ink text-sm font-semibold">Koppla dimension till egen fastighet</h4>
            {properties.isLoading ? (
              <p role="status" className="text-ink-muted text-sm">
                Hämtar organisationens fastigheter…
              </p>
            ) : properties.isError ? (
              <div>
                <p role="alert" className="text-sm text-red-600">
                  Fastigheterna kunde inte hämtas.
                </p>
                <Button size="sm" type="button" onClick={() => void properties.refetch()}>
                  Hämta fastigheter igen
                </Button>
              </div>
            ) : (
              <fieldset disabled={locked || properties.isFetching} className="min-w-0 space-y-3">
                <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                  <Select
                    label="Dimension i Fortnox"
                    value={selectedDimension}
                    options={[
                      { value: '', label: 'Välj dimension' },
                      ...data.dimensions.map((item) => ({
                        value: dimensionKey(item),
                        label: `${item.dimensionType === 'PROJECT' ? 'Projekt' : 'Kostnadsställe'} ${item.code}${item.name ? ` – ${item.name}` : ''}`,
                      })),
                    ]}
                    onChange={(event) => setSelectedDimension(event.target.value)}
                  />
                  <Select
                    label="Egen fastighet"
                    value={propertyId}
                    options={[
                      { value: '', label: 'Välj fastighet' },
                      ...ownProperties.map((property) => ({
                        value: property.id,
                        label: property.name,
                      })),
                    ]}
                    onChange={(event) => setPropertyId(event.target.value)}
                  />
                </div>
                {ownProperties.length === 0 && (
                  <p className="text-ink-muted text-sm">
                    Inga fastigheter i din organisation finns att välja.
                  </p>
                )}
                {data.dimensions.length === 0 && (
                  <p className="text-ink-muted text-sm">
                    Fortnox-företaget har inga kostnadsställen eller projekt. Kostnader redovisas då
                    som ofördelade; lägg upp dimensioner i Fortnox om de ska kopplas till fastighet.
                  </p>
                )}
                <Button
                  type="submit"
                  disabled={
                    locked || Boolean(mappingProblem) || properties.isFetching || properties.isError
                  }
                >
                  {mapping.isPending ? 'Sparar koppling…' : 'Spara fastighetskoppling'}
                </Button>
              </fieldset>
            )}
            <p className="text-ink-muted text-xs">
              En sparad koppling används vid nästa läsning. Tidigare underlag räknas inte om.
            </p>
          </form>
        </>
      )}
      {needsRefresh && (
        <p className="text-sm font-medium text-amber-600">Hämta om valen innan nästa försök.</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-ink text-sm">
          {notice}
        </p>
      )}
    </section>
  )
}
