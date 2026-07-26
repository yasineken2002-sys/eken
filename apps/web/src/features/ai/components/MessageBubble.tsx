import { motion } from 'framer-motion'
import { Sparkles } from 'lucide-react'
import type { AiMessage } from '../api/ai.api'

/** En bubbla i konversationen. Användaren höger, assistenten vänster med ikon. */
export function MessageBubble({ msg }: { msg: AiMessage }) {
  const isUser = msg.role === 'user'
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={`flex gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
    >
      {!isUser && (
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-gray-100 bg-white shadow-sm">
          <Sparkles size={14} strokeWidth={1.8} className="text-blue-500" />
        </div>
      )}
      <div
        className={`max-w-[70%] rounded-2xl px-4 py-2.5 ${
          isUser
            ? 'rounded-tr-sm bg-[#1A7C45] text-white'
            : 'rounded-tl-sm border border-gray-100 bg-white text-gray-800'
        }`}
      >
        <p
          className={`whitespace-pre-wrap text-[13.5px] leading-relaxed ${
            isUser ? 'text-white' : 'text-gray-800'
          }`}
        >
          {msg.content}
        </p>
      </div>
    </motion.div>
  )
}
