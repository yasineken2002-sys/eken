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
  iconColor = '#218F52',
  delay = 0,
  compact,
}: Props) {
  const positive = change !== undefined && change >= 0
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay }}
      className={cn(
        'rounded border bg-white transition-shadow hover:shadow-sm',
        compact ? 'p-4' : 'p-5',
      )}
      style={{ borderColor: '#E3E7EC' }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[12.5px] font-medium leading-tight" style={{ color: '#6B7684' }}>
          {title}
        </p>
        {Icon && (
          <div
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded"
            style={{ background: `${iconColor}14` }}
          >
            <Icon size={14} strokeWidth={1.8} style={{ color: iconColor }} />
          </div>
        )}
      </div>
      <p
        className={cn(
          'mt-2 font-semibold leading-none tracking-tight',
          compact ? 'text-[22px]' : 'text-[26px]',
        )}
        style={{ color: '#182030' }}
      >
        {value}
      </p>
      {change !== undefined && (
        <div className="mt-2 flex items-center gap-1">
          {positive ? (
            <TrendingUp size={11} className="flex-shrink-0" style={{ color: '#218F52' }} />
          ) : (
            <TrendingDown size={11} className="flex-shrink-0" style={{ color: '#DC3545' }} />
          )}
          <span
            className="text-[11.5px] font-semibold"
            style={{ color: positive ? '#196638' : '#B91C2A' }}
          >
            {positive ? '+' : ''}
            {change}%
          </span>
          {changeLabel && (
            <span className="text-[11.5px]" style={{ color: '#8A95A3' }}>
              {changeLabel}
            </span>
          )}
        </div>
      )}
    </motion.div>
  )
}
