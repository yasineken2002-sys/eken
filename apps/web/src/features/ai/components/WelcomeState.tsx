import { motion } from 'framer-motion'
import {
  Sparkles,
  AlertTriangle,
  FileText,
  TrendingUp,
  Building2,
  Users,
  type LucideIcon,
} from 'lucide-react'

interface Suggestion {
  icon: LucideIcon
  label: string
  color: string
  bg: string
}

/**
 * Snabbstart-chipsen i tomt läge. Etiketten skickas ordagrant som prompt, så
 * texten är inte bara en rubrik — den är indata till assistenten.
 */
const SUGGESTIONS: Suggestion[] = [
  {
    icon: AlertTriangle,
    label: 'Vilka hyresgäster har förfallna fakturor?',
    color: 'var(--ev-danger-600)',
    bg: 'var(--ev-danger-50)',
  },
  {
    icon: FileText,
    label: 'Skapa hyresfakturor för maj 2026',
    color: 'var(--ev-success-600)',
    bg: 'var(--ev-success-50)',
  },
  {
    icon: TrendingUp,
    label: 'Visa intäkter för Q1 2026',
    color: 'var(--ev-brand)',
    bg: 'var(--ev-brand-50)',
  },
  {
    icon: AlertTriangle,
    label: 'Skicka påminnelser till förfallna fakturor',
    color: 'var(--ev-warning-600)',
    bg: 'var(--ev-warning-50)',
  },
  { icon: Building2, label: 'Hur många lediga enheter finns?', color: '#7C3AED', bg: '#F5F3FF' },
  {
    icon: Users,
    label: 'Exportera bokföring för 2026',
    color: 'var(--ev-neutral-500)',
    bg: 'var(--ev-neutral-50)',
  },
]

interface WelcomeStateProps {
  onSuggestion: (label: string) => void
}

/** Tomt läge: hälsning + snabbstart-chips. Visas när ingen konversation är vald. */
export function WelcomeState({ onSuggestion }: WelcomeStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 py-12">
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3 }}
        className="flex h-16 w-16 items-center justify-center rounded-2xl border border-gray-100 bg-white shadow-md"
      >
        <Sparkles size={28} strokeWidth={1.5} className="text-blue-500" />
      </motion.div>
      <motion.h2
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="mt-4 text-[20px] font-semibold text-gray-900"
      >
        Hej! Jag är Eveno AI
      </motion.h2>
      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
        className="mt-2 max-w-sm text-center text-[13.5px] text-gray-500"
      >
        Jag kan analysera din fastighetsportfölj, skapa fakturor, hantera hyresgäster och ge dig
        konkreta råd — allt baserat på aktuell data.
      </motion.p>

      {/* Suggestion chips */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="mt-8 grid w-full max-w-lg grid-cols-2 gap-2"
      >
        {SUGGESTIONS.map((s) => (
          <button
            key={s.label}
            onClick={() => onSuggestion(s.label)}
            className="flex items-center gap-2.5 rounded-xl border border-gray-100 bg-white px-4 py-3 text-left transition-all hover:border-blue-200 hover:shadow-sm active:scale-[0.98]"
          >
            <div
              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg"
              style={{ background: s.bg }}
            >
              <s.icon size={14} strokeWidth={1.8} style={{ color: s.color }} />
            </div>
            <span className="text-[12.5px] font-medium text-gray-700">{s.label}</span>
          </button>
        ))}
      </motion.div>
    </div>
  )
}
