import { motion, AnimatePresence } from 'framer-motion'
import { Sparkles } from 'lucide-react'
import { LoadingDots } from './LoadingDots'
import { MessageBubble } from './MessageBubble'
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
  /**
   * name → etikett ur backends verktygskatalog. Tom medan katalogen hämtas;
   * då visas verktygsnamnet läsbart i stället. Frontend har medvetet ingen
   * egen etikettlista — se ai.api.ts.
   */
  toolLabels: Record<string, string>
  /**
   * Satt när turtaket nåddes: svaret är OFULLSTÄNDIGT.
   *
   * Markeringen står redan i `streamingText` (backend skickar den som en delta),
   * men den ska inte gå att läsa förbi som brödtext — därför en egen varningsyta.
   */
  iterationCapped: { toolRounds: number; maxToolRounds: number } | null
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
  toolLabels,
  iterationCapped,
  endRef,
}: MessageListProps) {
  const describe = (name: string) => toolLabels[name] ?? name.replace(/_/g, ' ')
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
                      {describe(evt.name)}
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
            {iterationCapped && (
              <div
                role="alert"
                className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3"
              >
                <p className="text-[13px] font-semibold text-amber-700">
                  Uppgiften slutfördes inte
                </p>
                <p className="mt-1 text-[12px] leading-relaxed text-amber-700">
                  Assistenten nådde gränsen på {iterationCapped.maxToolRounds} verktygsomgångar och
                  avbröts mitt i arbetet. Svaret ovan är ofullständigt — utgå inte från att något
                  som nämns är utfört. Dela upp frågan i mindre steg och fråga igen.
                </p>
              </div>
            )}
          </div>
        </motion.div>
      )}

      <div ref={endRef} />
    </div>
  )
}
