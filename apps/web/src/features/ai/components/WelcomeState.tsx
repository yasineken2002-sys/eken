import { motion } from 'framer-motion'
import {
  Sparkles,
  Receipt,
  ArrowLeftRight,
  FileText,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react'

interface Suggestion {
  icon: LucideIcon
  /** Kort etikett i chipet. */
  label: string
  /** Det som faktiskt skickas till assistenten när chipet klickas. */
  prompt: string
}

/**
 * Fyra snabbstarter, en per återkommande arbetsuppgift. Etiketten är kort och
 * läsbar; `prompt` är den fullständiga frågan som skickas — de var samma sträng
 * förut, vilket tvingade etiketterna att vara hela meningar.
 *
 * Ikonerna är samma linjeikoner som motsvarande sidor i sidomenyn använder, i
 * varumärkesgrönt. (`text-blue-600` ÄR grönt sedan F5 — blå familjen pekar på
 * varumärkesskalan.)
 */
const SUGGESTIONS: Suggestion[] = [
  {
    icon: Receipt,
    label: 'Förfallna avier',
    prompt: 'Vilka hyresavier är förfallna just nu?',
  },
  {
    icon: ArrowLeftRight,
    label: 'Stäm av bank',
    prompt: 'Visa omatchade banktransaktioner',
  },
  {
    icon: FileText,
    label: 'Skapa faktura',
    prompt: 'Skapa en faktura',
  },
  {
    icon: TrendingUp,
    label: 'Hyreshöjning',
    prompt: 'Beräkna hyreshöjningar för nästa år',
  },
]

/** Hälsningen ovanför kompositören i tomt läge. */
export function WelcomeGreeting() {
  return (
    <div className="flex flex-col items-center">
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3 }}
        className="border-line bg-surface flex h-14 w-14 items-center justify-center rounded-2xl border shadow-sm"
      >
        <Sparkles size={26} strokeWidth={1.5} className="text-blue-600" />
      </motion.div>
      <motion.h2
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="text-ink mt-4 text-[22px] font-semibold tracking-tight"
      >
        Hej! Vad vill du göra?
      </motion.h2>
      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="mt-1.5 max-w-md text-center text-[13.5px] text-gray-500"
      >
        Jag har tillgång till din portfölj — fråga om läget, eller be mig utföra något. Bindande
        åtgärder visar jag alltid för bekräftelse först.
      </motion.p>
    </div>
  )
}

interface SuggestionChipsProps {
  onSelect: (prompt: string) => void
}

/** Snabbstart-chipsen under kompositören i tomt läge. */
export function SuggestionChips({ onSelect }: SuggestionChipsProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2 }}
      className="flex flex-wrap items-center justify-center gap-2"
    >
      {SUGGESTIONS.map((s) => (
        <button
          key={s.label}
          onClick={() => onSelect(s.prompt)}
          title={s.prompt}
          className="border-line bg-surface flex items-center gap-2 rounded-full border px-3.5 py-2 transition-all hover:border-blue-300 hover:shadow-sm active:scale-[0.98]"
        >
          <s.icon size={14} strokeWidth={1.8} className="text-blue-600" />
          <span className="text-[12.5px] font-medium text-gray-700">{s.label}</span>
        </button>
      ))}
    </motion.div>
  )
}
