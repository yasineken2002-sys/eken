import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  X,
  TrendingUp,
  Building2,
  AlertTriangle,
  BarChart2,
  Info,
  AlertOctagon,
  CheckCircle2,
} from 'lucide-react'
import { analyzePortfolio } from '../api/ai.api'
import { cn } from '@/lib/cn'
import { formatDate } from '@eken/shared'
import type { PortfolioAnalysis, PortfolioInsight } from '../api/ai.api'

interface AnalysisModalProps {
  open: boolean
  onClose: () => void
}

const ANALYSIS_TYPES = [
  {
    key: 'revenue',
    label: 'Intäktsanalys',
    icon: TrendingUp,
    color: 'text-blue-600',
    bg: 'bg-blue-50',
  },
  {
    key: 'occupancy',
    label: 'Uthyrningsgrad',
    icon: Building2,
    color: 'text-emerald-600',
    bg: 'bg-emerald-50',
  },
  {
    key: 'risks',
    label: 'Riskanalys',
    icon: AlertTriangle,
    color: 'text-amber-600',
    bg: 'bg-amber-50',
  },
  {
    key: 'full',
    label: 'Full analys',
    icon: BarChart2,
    color: 'text-purple-600',
    bg: 'bg-purple-50',
  },
] as const

function SeverityIcon({ severity }: { severity: PortfolioInsight['severity'] }) {
  if (severity === 'critical')
    return <AlertOctagon size={16} strokeWidth={1.8} className="flex-shrink-0 text-red-600" />
  if (severity === 'warning')
    return <AlertTriangle size={16} strokeWidth={1.8} className="flex-shrink-0 text-amber-600" />
  return <Info size={16} strokeWidth={1.8} className="flex-shrink-0 text-blue-600" />
}

function SeverityBadge({ severity }: { severity: PortfolioInsight['severity'] }) {
  const map = {
    critical: 'bg-red-50 text-red-600',
    warning: 'bg-amber-50 text-amber-700',
    info: 'bg-blue-50 text-blue-700',
  }
  const labels = { critical: 'Kritisk', warning: 'Varning', info: 'Info' }
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', map[severity])}>
      {labels[severity]}
    </span>
  )
}

export function AnalysisModal({ open, onClose }: AnalysisModalProps) {
  const [selectedType, setSelectedType] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [result, setResult] = useState<PortfolioAnalysis | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleAnalyze = async (type: string) => {
    setSelectedType(type)
    setIsLoading(true)
    setResult(null)
    setError(null)
    try {
      const data = await analyzePortfolio(type)
      setResult(data)
    } catch {
      setError(
        'Analysen misslyckades. Kontrollera att det finns data i portföljen och försök igen.',
      )
    } finally {
      setIsLoading(false)
    }
  }

  const handleClose = () => {
    setSelectedType(null)
    setResult(null)
    setError(null)
    onClose()
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          {/* Backdrop */}
          <motion.div
            className="absolute inset-0 bg-black/25 backdrop-blur-[2px]"
            onClick={handleClose}
          />

          {/* Panel */}
          <motion.div
            className="relative z-10 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[#EAEDF0] bg-white shadow-xl"
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-[#EAEDF0] px-6 py-4">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple-50">
                  <BarChart2 size={14} strokeWidth={1.8} className="text-purple-600" />
                </div>
                <span className="text-[17px] font-semibold text-gray-900">Analysera portfölj</span>
              </div>
              <button
                onClick={handleClose}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
              >
                <X size={15} strokeWidth={2} />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-6 py-5">
              {/* Type selector */}
              <p className="mb-3 text-[13px] font-medium text-gray-600">Välj analystyp</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {ANALYSIS_TYPES.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => void handleAnalyze(t.key)}
                    disabled={isLoading}
                    className={cn(
                      'flex flex-col items-center gap-2 rounded-xl border p-3 text-center transition-all active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-50',
                      selectedType === t.key
                        ? 'border-2 border-purple-300 bg-purple-50 shadow-sm'
                        : 'border-[#EAEDF0] hover:border-gray-300 hover:shadow-sm',
                    )}
                  >
                    <div
                      className={cn('flex h-8 w-8 items-center justify-center rounded-lg', t.bg)}
                    >
                      <t.icon size={16} strokeWidth={1.8} className={t.color} />
                    </div>
                    <span className="text-[12.5px] font-medium text-gray-700">{t.label}</span>
                  </button>
                ))}
              </div>

              {/* Loading */}
              {isLoading && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-6 flex flex-col items-center justify-center gap-3 py-8"
                >
                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-purple-600 border-t-transparent" />
                  <p className="text-[13.5px] text-gray-500">AI:n analyserar din portfölj...</p>
                </motion.div>
              )}

              {/* Error */}
              {error && !isLoading && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-6 rounded-xl bg-red-50 p-4 text-[13px] text-red-700"
                >
                  {error}
                </motion.div>
              )}

              {/* Result */}
              {result && !isLoading && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-6 space-y-5"
                >
                  {/* Summary */}
                  <div className="rounded-xl bg-gray-50 p-4">
                    <p className="text-[15px] font-medium leading-relaxed text-gray-800">
                      {result.summary}
                    </p>
                  </div>

                  {/* Insights */}
                  {result.insights.length > 0 && (
                    <div>
                      <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                        Insikter ({result.insights.length})
                      </p>
                      <div className="space-y-2">
                        {result.insights.map((insight, i) => (
                          <div key={i} className="rounded-xl border border-[#EAEDF0] bg-white p-4">
                            <div className="flex items-start gap-3">
                              <SeverityIcon severity={insight.severity} />
                              <div className="min-w-0 flex-1">
                                <div className="mb-1 flex flex-wrap items-center gap-2">
                                  <span className="text-[13px] font-semibold text-gray-700">
                                    {insight.category}
                                  </span>
                                  <SeverityBadge severity={insight.severity} />
                                </div>
                                <p className="text-[13px] text-gray-600">{insight.finding}</p>
                                {insight.action && (
                                  <p className="mt-1.5 text-[12px] italic text-gray-500">
                                    Åtgärd: {insight.action}
                                  </p>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Recommendations */}
                  {result.recommendations.length > 0 && (
                    <div>
                      <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                        Rekommendationer
                      </p>
                      <div className="space-y-2">
                        {result.recommendations.map((rec, i) => (
                          <div key={i} className="flex items-start gap-2.5">
                            <CheckCircle2
                              size={15}
                              strokeWidth={2}
                              className="mt-0.5 flex-shrink-0 text-emerald-600"
                            />
                            <p className="text-[13px] text-gray-700">{rec}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Footer */}
                  <p className="text-right text-[11px] text-gray-300">
                    Genererad {formatDate(result.generatedAt)}
                  </p>
                </motion.div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
