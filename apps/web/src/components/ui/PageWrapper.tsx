import { motion } from 'framer-motion'

interface Props {
  id: string
  children: React.ReactNode
}

export function PageWrapper({ id, children }: Props) {
  return (
    <motion.div
      key={id}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.2 }}
      className="mx-auto max-w-[1200px] px-6 py-6"
    >
      {children}
    </motion.div>
  )
}
