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
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className={cn('flex items-start justify-between gap-4', className)}
    >
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight text-gray-900">{title}</h1>
        {description && <p className="mt-0.5 text-[13.5px] text-gray-500">{description}</p>}
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </motion.div>
  )
}
