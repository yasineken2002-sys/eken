import { motion } from 'framer-motion'
import { cn } from '@/lib/cn'

interface Props {
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}

export function PageHeader({ title, description, action, className }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={cn('flex items-start justify-between gap-4', className)}
    >
      <div>
        <h1 className="text-[26px] font-bold leading-tight tracking-tight text-gray-900">
          {title}
        </h1>
        {description && <p className="mt-1 text-[14px] text-gray-500">{description}</p>}
      </div>
      {action && <div className="flex-shrink-0 pt-0.5">{action}</div>}
    </motion.div>
  )
}
