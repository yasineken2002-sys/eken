import { motion } from 'framer-motion'
import type { LucideIcon } from 'lucide-react'

interface Props {
  icon: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
}

export function EmptyState({ icon: Icon, title, description, action }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center justify-center py-20 text-center"
    >
      <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-[#EAEDF0] bg-gray-50">
        <Icon size={24} strokeWidth={1.5} className="text-gray-300" />
      </div>
      <p className="text-[15px] font-semibold text-gray-700">{title}</p>
      {description && <p className="mt-1 max-w-xs text-[13px] text-gray-400">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </motion.div>
  )
}
