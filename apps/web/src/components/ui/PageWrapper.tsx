import { motion } from 'framer-motion'

interface Props {
  id: string
  children: React.ReactNode
}

export function PageWrapper({ id, children }: Props) {
  return (
    <motion.div
      key={id}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.18 }}
      className="mx-auto max-w-[1280px] px-7 py-7"
    >
      {children}
    </motion.div>
  )
}
