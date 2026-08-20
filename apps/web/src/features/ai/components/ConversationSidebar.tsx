import { Sparkles, Plus, Trash2, MessageSquare, BarChart2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { formatDate } from '@eken/shared'
import type { AiConversation } from '../api/ai.api'

interface ConversationSidebarProps {
  conversations: AiConversation[]
  isLoading: boolean
  activeConversationId: string | null
  confirmDeleteId: string | null
  onSelect: (id: string) => void
  onNewConversation: () => void
  onRequestDelete: (id: string | null) => void
  onConfirmDelete: (id: string) => void
  onOpenAnalysis: () => void
}

/** Vänsterpanelen: rubrik, ny konversation, konversationslista och portföljanalys. */
export function ConversationSidebar({
  conversations,
  isLoading,
  activeConversationId,
  confirmDeleteId,
  onSelect,
  onNewConversation,
  onRequestDelete,
  onConfirmDelete,
  onOpenAnalysis,
}: ConversationSidebarProps) {
  return (
    <div className="flex w-[280px] flex-shrink-0 flex-col border-r border-gray-100 bg-white">
      {/* Header */}
      <div className="border-b border-gray-100 px-4 py-3">
        <div className="mb-3 flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-50">
            <Sparkles size={14} strokeWidth={1.8} className="text-blue-600" />
          </div>
          <span className="text-[14px] font-semibold text-gray-900">Eveno AI</span>
        </div>
        <Button variant="primary" size="sm" className="w-full" onClick={onNewConversation}>
          <Plus size={13} strokeWidth={2} />
          Ny konversation
        </Button>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto py-2">
        {isLoading ? (
          <div className="space-y-1 px-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-12 animate-pulse rounded-lg bg-gray-100" />
            ))}
          </div>
        ) : conversations.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
            <MessageSquare size={20} strokeWidth={1.5} className="mb-2 text-gray-200" />
            <p className="text-[12.5px] text-gray-400">Inga konversationer ännu</p>
          </div>
        ) : (
          <div className="space-y-0.5 px-2">
            {conversations.map((conv) => {
              const active = activeConversationId === conv.id
              const lastMsg = conv.messages[0]
              return (
                <div
                  key={conv.id}
                  className={`group relative flex cursor-pointer items-start gap-2 rounded-lg px-3 py-2.5 transition-colors ${
                    active ? 'bg-blue-50' : 'hover:bg-gray-50'
                  }`}
                  onClick={() => onSelect(conv.id)}
                >
                  <div className="min-w-0 flex-1">
                    <p
                      className={`truncate text-[13px] font-medium ${
                        active ? 'text-blue-700' : 'text-gray-800'
                      }`}
                    >
                      {conv.title}
                    </p>
                    {lastMsg && (
                      <p className="mt-0.5 truncate text-[11.5px] text-gray-400">
                        {lastMsg.content}
                      </p>
                    )}
                    <p className="mt-0.5 text-[11px] text-gray-400">{formatDate(conv.updatedAt)}</p>
                  </div>

                  {confirmDeleteId === conv.id ? (
                    <div
                      className="flex flex-shrink-0 items-center gap-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => onConfirmDelete(conv.id)}
                        className="rounded px-1.5 py-0.5 text-[11px] font-medium text-red-600 hover:bg-red-50"
                      >
                        Ja
                      </button>
                      <button
                        onClick={() => onRequestDelete(null)}
                        className="rounded px-1.5 py-0.5 text-[11px] font-medium text-gray-500 hover:bg-gray-100"
                      >
                        Nej
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onRequestDelete(conv.id)
                      }}
                      className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-gray-300 opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
                    >
                      <Trash2 size={12} strokeWidth={1.8} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Analysis button */}
      <div className="border-t border-gray-100 p-3">
        <button
          onClick={onOpenAnalysis}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium text-gray-600 transition-colors hover:bg-gray-50"
        >
          <BarChart2 size={14} strokeWidth={1.8} className="text-blue-600" />
          Analysera portfölj
        </button>
      </div>
    </div>
  )
}
