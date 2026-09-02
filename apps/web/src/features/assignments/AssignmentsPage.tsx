import { useState } from 'react'
import { Inbox } from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadErrorState } from '@/components/ui/LoadErrorState'
import { PermissionDeniedState } from '@/components/ui/PermissionDeniedState'
import { isForbidden } from '@/lib/api'
import { cn } from '@/lib/cn'
import { AssignmentCard } from './components/AssignmentCard'
import { useAssignments, useDecideAssignment } from './hooks/useAssignments'
import type { AssignmentStatus } from './api/assignments.api'

/**
 * LÄSYTAN FÖR UPPDRAGSKÖN — den MINIMALA, inte inkorgen.
 *
 * Inkorgen (planens Del 11) är etapp 6 och har tre sektioner, delegationsförslag
 * och en frågebudget. Den här sidan har en lista och två knappar, och det är
 * hela poängen: kön får inte landa utan läsare, men läsaren ska inte låtsas vara
 * något den inte är.
 *
 * ── DET TOMMA TILLSTÅNDET SÄGER VARFÖR DET ÄR TOMT ──────────────────────────
 *
 * Kön ÄR tom, och kommer att vara det tills agenten byggs (etapp 8–9).
 * "Inget behöver dig idag" hade varit en lögn med rätt ton — den beskriver en
 * kö som fungerar och råkar vara tom, inte en kö som ingen ännu fyller. Texten
 * säger vilket av de två det är, så att ingen felsöker en frånvaro.
 */

const FLIKAR: Array<{ id: AssignmentStatus | 'alla'; label: string }> = [
  { id: 'AWAITING_APPROVAL', label: 'Väntar på dig' },
  { id: 'alla', label: 'Alla' },
]

export function AssignmentsPage() {
  const [flik, setFlik] = useState<AssignmentStatus | 'alla'>('AWAITING_APPROVAL')
  const { data, isLoading, isError, error, refetch } = useAssignments(
    flik === 'alla' ? undefined : flik,
  )
  const besluta = useDecideAssignment()

  const uppdrag = data ?? []

  return (
    <PageWrapper id="assignments">
      <PageHeader
        title="Uppdrag"
        description="Sådant AI:n förberett åt dig och som väntar på ditt beslut."
      />

      <div className="mt-6 flex w-fit gap-1 rounded-xl bg-gray-100 p-1">
        {FLIKAR.map((f) => (
          <button
            key={f.id}
            onClick={() => setFlik(f.id)}
            className={cn(
              'h-8 rounded-lg px-3 text-[13px] font-medium transition-colors',
              flik === f.id
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {isError ? (
          // Ett haveri ska inte se ut som ett nekande — skiljelinjen är
          // isForbidden(), inte isError.
          isForbidden(error) ? (
            <PermissionDeniedState vad="uppdragskön" />
          ) : (
            <LoadErrorState vad="uppdragskön" onRetry={() => void refetch()} />
          )
        ) : isLoading ? (
          <p className="py-20 text-center text-[13px] text-gray-400">Hämtar uppdrag…</p>
        ) : uppdrag.length === 0 ? (
          <EmptyState
            icon={Inbox}
            title="Inga uppdrag än"
            description={
              flik === 'AWAITING_APPROVAL'
                ? 'Inget väntar på ditt beslut. Kön fylls av AI-agenten, som ännu inte är byggd — så tomt är just nu det förväntade läget, inte ett fel.'
                : 'Kön är tom. Den fylls av AI-agenten, som ännu inte är byggd.'
            }
          />
        ) : (
          <div className="space-y-3">
            {uppdrag.map((u) => (
              <AssignmentCard
                key={u.id}
                assignment={u}
                isDeciding={besluta.isPending}
                onDecide={(decision) => {
                  // Avslagets skäl är minnesmat (planens Del 11) och krävs av
                  // servern. v1 frågar rakt ut; etapp 6 gör det till ett kort.
                  if (decision === 'REJECTED') {
                    const reason = window.prompt('Varför avslår du uppdraget?')?.trim() ?? ''
                    // Tomt skäl = avbryt. Servern hade avvisat det ändå, men ett
                    // avbrutet prompt ska inte se ut som ett misslyckat anrop.
                    if (!reason) return
                    besluta.mutate({ id: u.id, decision, reason })
                    return
                  }
                  besluta.mutate({ id: u.id, decision })
                }}
              />
            ))}
          </div>
        )}
      </div>
    </PageWrapper>
  )
}
