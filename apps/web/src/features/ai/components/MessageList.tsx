import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles } from 'lucide-react'
import { LoadingDots } from './LoadingDots'
import { MessageBubble } from './MessageBubble'
import { describeTool } from '../api/ai.api'
import { cn } from '@/lib/cn'
import type { AiMessage } from '../api/ai.api'

export interface ToolEvent {
  id: string
  name: string
  status: 'starting' | 'executing' | 'done'
}

interface MessageListProps {
  messages: AiMessage[]
  isThinking: boolean
  isStreaming: boolean
  streamingText: string
  toolEvents: ToolEvent[]
  /** Ankare längst ned som sidan scrollar till när något nytt kommer in. */
  endRef: React.RefObject<HTMLDivElement>
}

/**
 * Konversationen: färdiga meddelanden, "tänker"-indikatorn för den icke-
 * strömmande verktygsvägen, och den strömmande bubblan med verktygsspåret.
 */
export function MessageList({
  messages,
  isThinking,
  isStreaming,
  streamingText,
  toolEvents,
  endRef,
}: MessageListProps) {
  return (
    <div className="mx-auto max-w-3xl space-y-5 px-6 py-6">
      <AnimatePresence initial={false}>
        {messages.map((msg) => (
          <MessageBubble key={msg.id} msg={msg} />
        ))}
      </AnimatePresence>

      {isThinking && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex gap-3"
        >
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-gray-100 bg-white shadow-sm">
            <Sparkles size={14} strokeWidth={1.8} className="text-blue-500" />
          </div>
          <div className="rounded-2xl rounded-tl-sm border border-gray-100 bg-white px-4 py-2.5">
            <div className="flex items-center gap-2">
              <LoadingDots />
              <span className="text-[12px] text-gray-400">Analyserar din data...</span>
            </div>
          </div>
        </motion.div>
      )}

      {isStreaming && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex gap-3"
        >
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-gray-100 bg-white shadow-sm">
            <Sparkles size={14} strokeWidth={1.8} className="animate-pulse text-blue-500" />
          </div>
          <div className="max-w-[70%] rounded-2xl rounded-tl-sm border border-gray-100 bg-white px-4 py-2.5">
            {toolEvents.length > 0 && (
              <div className="mb-2 flex flex-col gap-1">
                {toolEvents.map((evt) => (
                  <motion.div
                    key={evt.id}
                    initial={{ opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="flex items-center gap-2 text-[12px] text-gray-500"
                  >
                    <span
                      className={cn(
                        'inline-flex h-1.5 w-1.5 rounded-full',
                        evt.status === 'done' ? 'bg-emerald-500' : 'animate-pulse bg-gray-500',
                      )}
                    />
                    <span>
                      {describeTool(evt.name)}
                      {evt.status === 'done' ? '' : '…'}
                    </span>
                  </motion.div>
                ))}
              </div>
            )}
            {streamingText ? (
              <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-gray-800">
                {streamingText}
                <span className="cursor">▋</span>
              </p>
            ) : toolEvents.length === 0 ? (
              <div className="flex items-center gap-2">
                <LoadingDots />
                <span className="text-[12px] text-gray-400">Tänker...</span>
              </div>
            ) : null}
          </div>
        </motion.div>
      )}

      <div ref={endRef} />
    </div>
  )
}
