import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2 } from 'lucide-react'
import { PageHeader } from '@/components/ui/PageHeader'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { SeverityBadge } from '@/components/ui/Badge'
import { Select } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { get, post } from '@/lib/api'
import { formatDateTime } from '@/lib/format'

interface ErrorItem {
  id: string
  severity: 'CRITICAL' | 'ERROR' | 'WARNING'
  source: string
  message: string
  stack: string | null
  context: Record<string, unknown> | null
  resolved: boolean
  resolvedAt: string | null
  createdAt: string
  organization: { id: string; name: string } | null
}

export function ErrorsPage() {
  const [severity, setSeverity] = useState<'' | ErrorItem['severity']>('')
  const [resolved, setResolved] = useState<'' | 'true' | 'false'>('false')
  const [selected, setSelected] = useState<ErrorItem | null>(null)
  const qc = useQueryClient()

  const params: Record<string, string> = { pageSize: '200' }
  if (severity) params['severity'] = severity
  if (resolved) params['resolved'] = resolved

  const { data } = useQuery({
    queryKey: ['platform', 'errors', severity, resolved],
    queryFn: () => get<{ items: ErrorItem[] }>('/platform/errors', params),
  })

  const resolve = useMutation({
    mutationFn: (id: string) => post(`/platform/errors/${id}/resolve`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['platform', 'errors'] })
      qc.invalidateQueries({ queryKey: ['platform', 'overview'] })
      setSelected(null)
    },
  })

  return (
    <>
      <PageHeader title="Fel-logg" description="Kritiska och oförväntade fel på plattformen" />

      <div className="mt-6 flex gap-3">
        <Select
          value={severity}
          onChange={(e) => setSeverity(e.target.value as ErrorItem['severity'] | '')}
          className="w-48"
        >
          <option value="">Alla severity</option>
          <option value="CRITICAL">Critical</option>
          <option value="ERROR">Error</option>
          <option value="WARNING">Warning</option>
        </Select>
        <Select
          value={resolved}
          onChange={(e) => setResolved(e.target.value as '' | 'true' | 'false')}
          className="w-48"
        >
          <option value="false">Olösta</option>
          <option value="true">Lösta</option>
          <option value="">Alla</option>
        </Select>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardBody className="p-0">
            <ul className="divide-y divide-[#EAEDF0]">
              {(data?.items ?? []).map((e) => (
                <li
                  key={e.id}
                  onClick={() => setSelected(e)}
                  className={`cursor-pointer px-5 py-3 transition-colors hover:bg-gray-50 ${selected?.id === e.id ? 'bg-blue-50/50' : ''}`}
                >
                  <div className="flex items-center gap-2">
                    <SeverityBadge severity={e.severity} />
                    <span className="text-[12px] text-gray-500">{e.source}</span>
                    {e.organization ? (
                      <span className="text-[12px] text-gray-500">· {e.organization.name}</span>
                    ) : null}
                    <span className="ml-auto text-[12px] text-gray-500">
                      {formatDateTime(e.createdAt)}
                    </span>
                  </div>
                  <div className="mt-1 text-[13.5px] text-gray-900">{e.message}</div>
                  {e.resolved ? (
                    <div className="mt-1 flex items-center gap-1 text-[11.5px] text-emerald-600">
                      <CheckCircle2 size={12} /> Löst
                    </div>
                  ) : null}
                </li>
              ))}
              {data && data.items.length === 0 ? (
                <li className="px-5 py-10 text-center text-[13px] text-gray-500">Inga fel.</li>
              ) : null}
            </ul>
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          {selected ? (
            <>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <SeverityBadge severity={selected.severity} />
                      <span className="text-[12px] text-gray-500">{selected.source}</span>
                    </div>
                    <div className="mt-1 text-[13.5px] font-medium text-gray-900">
                      {selected.message}
                    </div>
                  </div>
                  {!selected.resolved ? (
                    <Button
                      size="sm"
                      onClick={() => resolve.mutate(selected.id)}
                      loading={resolve.isPending}
                    >
                      Markera löst
                    </Button>
                  ) : null}
                </div>
              </CardHeader>
              <CardBody className="space-y-3 text-[12.5px]">
                <div>
                  <div className="text-[11.5px] font-semibold uppercase tracking-wide text-gray-400">
                    Tidpunkt
                  </div>
                  <div className="text-gray-900">{formatDateTime(selected.createdAt)}</div>
                </div>
                {selected.organization ? (
                  <div>
                    <div className="text-[11.5px] font-semibold uppercase tracking-wide text-gray-400">
                      Kund
                    </div>
                    <div className="text-gray-900">{selected.organization.name}</div>
                  </div>
                ) : null}
                <div>
                  <div className="text-[11.5px] font-semibold uppercase tracking-wide text-gray-400">
                    Context
                  </div>
                  <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-gray-50 p-2 text-[11px]">
                    {JSON.stringify(selected.context ?? {}, null, 2)}
                  </pre>
                </div>
                {selected.stack ? (
                  <div>
                    <div className="text-[11.5px] font-semibold uppercase tracking-wide text-gray-400">
                      Stack
                    </div>
                    <pre className="mt-1 max-h-60 overflow-auto rounded-lg bg-gray-50 p-2 text-[11px]">
                      {selected.stack}
                    </pre>
                  </div>
                ) : null}
              </CardBody>
            </>
          ) : (
            <CardBody>
              <div className="py-10 text-center text-[13px] text-gray-500">Välj ett fel.</div>
            </CardBody>
          )}
        </Card>
      </div>
    </>
  )
}
