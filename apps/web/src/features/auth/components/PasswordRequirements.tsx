import { motion, AnimatePresence } from 'framer-motion'
import { Check, X } from 'lucide-react'
import { passwordChecks } from '@eken/shared'
import { cn } from '@/lib/cn'

interface Props {
  password: string
  className?: string
}

export function PasswordRequirements({ password, className }: Props) {
  const checks = passwordChecks(password)
  return (
    <ul
      className={cn('space-y-1.5 rounded-xl border border-[#EAEDF0] bg-gray-50/60 p-3', className)}
      aria-label="Lösenordskrav"
    >
      {checks.map((c) => (
        <li key={c.key} className="flex items-center gap-2 text-[12.5px]">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={c.passed ? 'ok' : 'pending'}
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.8, opacity: 0 }}
              transition={{ duration: 0.12 }}
              className={cn(
                'flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full',
                c.passed
                  ? 'bg-emerald-500 text-white'
                  : 'border border-gray-300 bg-white text-gray-300',
              )}
            >
              {c.passed ? <Check size={10} strokeWidth={3} /> : <X size={9} strokeWidth={2.5} />}
            </motion.span>
          </AnimatePresence>
          <span
            className={cn('transition-colors', c.passed ? 'text-emerald-700' : 'text-gray-500')}
          >
            {c.label}
          </span>
        </li>
      ))}
    </ul>
  )
}
