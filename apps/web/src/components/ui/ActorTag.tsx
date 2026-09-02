import { Bot, CircleHelp, Cog, User } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * VEM SOM UTFÖRDE — delad mellan historikvyn och avins händelselogg.
 *
 * Komponenten flyttades hit från `features/history/components/` när avins
 * händelsevy (#648) behövde exakt samma sak. Att kopiera den hade garanterat
 * att de två glider isär — och `UNKNOWN`-fallets betydelse, som är det enda
 * svåra här, hade behövt bli rätt två gånger.
 *
 * TYPEN BOR HÄR NU, inte i historikens API-fil. Den beskriver komponentens
 * indata, inte ett svar från en viss endpoint; två anropare med olika
 * endpoints delar den utan att den ena måste importera den andras API-lager.
 */
export type ActorKind = 'HUMAN' | 'AGENT' | 'SYSTEM' | 'UNKNOWN'

export interface EventActor {
  kind: ActorKind
  id: string | null
  label: string | null
}

/**
 * AKTÖREN SYNS ALLTID — även när den inte är känd.
 *
 * `AGENT` finns i uppsättningen fastän ingen agent ännu skriver historik. Det
 * är avsiktligt: när agenten börjar arbeta ska dess rader hamna i SAMMA flöde
 * som människans och systemets, inte i en egen vy som byggs senare. Fältet är
 * platsen som redan står redo.
 *
 * `UNKNOWN` betyder en bestämd sak — KÄLLTABELLEN SAKNAR AKTÖRSKOLUMN — och
 * inte "kanske vem som helst". `Lease`, `Deposit`, `TerminationRequest` och
 * `MiscCharge` bär ingen `createdById`, så API:t vägrar påstå `SYSTEM` om det
 * en människa sannolikt gjorde. Etiketten och dess förklaring speglar det
 * exakt; att rendera tomt i stället hade återinfört gissningen i gränssnittet.
 */
const KINDS = {
  HUMAN: {
    label: 'Människa',
    icon: User,
    className: 'bg-gray-100 text-gray-600',
    title: 'Utförd av en inloggad användare.',
  },
  AGENT: {
    label: 'Agent',
    icon: Bot,
    className: 'bg-blue-50 text-blue-700',
    title: 'Utförd av AI-assistenten på en användares uppdrag.',
  },
  SYSTEM: {
    label: 'System',
    icon: Cog,
    className: 'bg-gray-100 text-gray-500',
    title: 'Utförd automatiskt av systemet — schemalagt jobb eller inkommande webhook.',
  },
  UNKNOWN: {
    label: 'Okänd',
    icon: CircleHelp,
    className: 'border border-gray-200 bg-transparent text-gray-400',
    title: 'Källtabellen saknar aktörskolumn — vem som utförde detta finns inte registrerat.',
  },
} as const

export function ActorTag({ actor }: { actor: EventActor }) {
  const spec = KINDS[actor.kind] ?? KINDS.UNKNOWN
  const Icon = spec.icon
  return (
    <span
      title={actor.label ? `${spec.title} (${actor.label})` : spec.title}
      className={cn(
        'inline-flex flex-shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
        spec.className,
      )}
    >
      <Icon size={11} strokeWidth={1.8} />
      {actor.label ?? spec.label}
    </span>
  )
}
