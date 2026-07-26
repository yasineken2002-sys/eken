import { Send, Mic, MicOff } from 'lucide-react'
import { cn } from '@/lib/cn'

/** Max höjd på textarean innan den börjar scrolla internt. */
const MAX_TEXTAREA_HEIGHT = 120

interface ComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  /** Skickning blockerad medan ett svar är på väg. */
  disabled: boolean
  isListening: boolean
  onStartVoice: () => void
  onStopVoice: () => void
  /**
   * Ägs av sidan: den nollställer höjden efter skickat meddelande och vid ny
   * konversation. Auto-resize under skrivandet sker här inne.
   */
  textareaRef: React.RefObject<HTMLTextAreaElement>
}

/** Inmatningsraden. A2 gör den till sidans huvudperson — här är den oförändrad. */
export function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  isListening,
  onStartVoice,
  onStopVoice,
  textareaRef,
}: ComposerProps) {
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value)
    const ta = textareaRef.current
    if (ta) {
      ta.style.height = 'auto'
      ta.style.height = `${Math.min(ta.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSubmit()
    }
  }

  return (
    <div className="border-t border-gray-100 bg-white px-6 py-4">
      <div className="mx-auto max-w-3xl">
        {isListening && (
          <div className="mb-2 flex items-center gap-2 text-[13px] text-red-500">
            <span className="animate-pulse">●</span>
            Lyssnar... Tala din fråga på svenska
          </div>
        )}
        <div className="flex items-end gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 transition-all focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="Skriv ett meddelande... (Enter för att skicka)"
            rows={1}
            className="flex-1 resize-none bg-transparent text-[13.5px] text-gray-800 placeholder-gray-400 outline-none"
            style={{ maxHeight: `${MAX_TEXTAREA_HEIGHT}px` }}
          />
          <div className="flex flex-shrink-0 items-center gap-2">
            {value.length > 0 && <span className="text-[11px] text-gray-400">{value.length}</span>}
            <button
              type="button"
              onClick={isListening ? onStopVoice : onStartVoice}
              className={cn(
                'rounded-lg p-2 transition-all',
                isListening
                  ? 'animate-pulse bg-red-100 text-red-600'
                  : 'text-gray-400 hover:text-gray-600',
              )}
              title={isListening ? 'Stoppa inspelning' : 'Tala'}
            >
              {isListening ? <MicOff size={18} /> : <Mic size={18} />}
            </button>
            <button
              onClick={onSubmit}
              disabled={!value.trim() || disabled}
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white transition-colors hover:bg-blue-700 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Send size={14} strokeWidth={2} />
            </button>
          </div>
        </div>
        <p className="mt-2 text-center text-[11px] text-gray-400">
          Eveno AI kan utföra åtgärder — åtgärder kräver alltid din bekräftelse.
        </p>
      </div>
    </div>
  )
}
