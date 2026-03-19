import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'

interface Props {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: React.ReactNode
  size?: 'sm' | 'md' | 'lg'
}

const sizes = { sm: 'max-w-[440px]', md: 'max-w-[560px]', lg: 'max-w-[720px]' }

export function Modal({ open, onClose, title, description, children, size = 'md' }: Props) {
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="absolute inset-0"
            style={{ background: 'rgba(15,22,35,0.45)', backdropFilter: 'blur(2px)' }}
            onClick={onClose}
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 6 }}
            transition={{ type: 'spring', stiffness: 380, damping: 30 }}
            className={cn('relative w-full overflow-hidden bg-white', sizes[size])}
            style={{
              borderRadius: '6px',
              border: '1px solid #D4D9E0',
              boxShadow: '0 20px 60px rgba(0,0,0,0.18), 0 4px 16px rgba(0,0,0,0.08)',
            }}
          >
            {/* Header */}
            <div
              className="flex items-center justify-between px-5 py-4"
              style={{ borderBottom: '1px solid #E8EAED' }}
            >
              <div>
                <h2 className="text-[15px] font-semibold" style={{ color: '#182030' }}>
                  {title}
                </h2>
                {description && (
                  <p className="mt-0.5 text-[12.5px]" style={{ color: '#6B7684' }}>
                    {description}
                  </p>
                )}
              </div>
              <button
                onClick={onClose}
                className="ml-4 flex h-7 w-7 items-center justify-center rounded transition-colors"
                style={{ color: '#8A95A3' }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = '#EEF1F4'
                  e.currentTarget.style.color = '#182030'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.color = '#8A95A3'
                }}
              >
                <X size={14} />
              </button>
            </div>

            {/* Body */}
            <div className="px-5 py-5">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}

export function ModalFooter({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn('mt-4 flex items-center justify-end gap-2 pt-4', className)}
      style={{ borderTop: '1px solid #E8EAED' }}
    >
      {children}
    </div>
  )
}
