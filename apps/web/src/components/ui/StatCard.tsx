import { motion } from 'framer-motion'
import { TrendingUp, TrendingDown } from 'lucide-react'
import { cn } from '@/lib/cn'

interface Props {
  title: string
  value: string | number
  change?: number
  changeLabel?: string
  icon?: React.ElementType
  iconColor?: string
  delay?: number
  compact?: boolean
}

export function StatCard({
  title,
  value,
  change,
  changeLabel,
  icon: Icon,
  iconColor = '#2563EB',
  delay = 0,
  compact,
}: Props) {
  const positive = change !== undefined && change >= 0
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay }}
      whileHover={{ y: -1, boxShadow: '0 8px 28px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.04)' }}
      className={cn(
        'rounded-2xl border border-gray-100 bg-white transition-shadow',
        compact ? 'p-4' : 'p-5',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-medium leading-snug text-gray-500">{title}</p>
        {Icon && (
          <div
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl"
            style={{ background: `${iconColor}14` }}
          >
            <Icon size={15} strokeWidth={1.8} style={{ color: iconColor }} />
          </div>
        )}
      </div>
      <p
        className={cn(
          'mt-2.5 font-bold leading-none tracking-tight text-gray-900',
          compact ? 'text-[24px]' : 'text-[30px]',
        )}
      >
        {value}
      </p>
      {change !== undefined && (
        <div className="mt-2.5 flex items-center gap-1.5">
          <div
            className={cn(
              'flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold',
              positive ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600',
            )}
          >
            {positive ? (
              <TrendingUp size={10} className="flex-shrink-0" />
            ) : (
              <TrendingDown size={10} className="flex-shrink-0" />
            )}
            {positive ? '+' : ''}
            {change}%
          </div>
          {changeLabel && <span className="text-[12px] text-gray-400">{changeLabel}</span>}
        </div>
      )}
    </motion.div>
  )
}
