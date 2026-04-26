import { motion } from 'framer-motion'
import { Building2 } from 'lucide-react'

interface Props {
  title: string
  description?: string
  children: React.ReactNode
  footer?: React.ReactNode
}

export function AuthCard({ title, description, children, footer }: Props) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#F7F8FA] px-6 py-12">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22 }}
        className="w-full max-w-[400px]"
      >
        <div className="mb-8 flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600">
            <Building2 size={15} className="text-white" strokeWidth={2.2} />
          </div>
          <span className="text-[20px] font-bold tracking-tight text-gray-900">Eken</span>
        </div>

        <div className="rounded-2xl border border-[#EAEDF0] bg-white p-7 shadow-sm">
          <h1 className="text-[22px] font-semibold tracking-tight text-gray-900">{title}</h1>
          {description && <p className="mt-1.5 text-[13.5px] text-gray-500">{description}</p>}

          <div className="mt-6">{children}</div>
        </div>

        {footer && <div className="mt-5 text-center text-[13px] text-gray-500">{footer}</div>}
      </motion.div>
    </div>
  )
}
