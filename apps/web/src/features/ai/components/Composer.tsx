import { Send, Mic, MicOff } from 'lucide-react'
import { cn } from '@/lib/cn'

/** Max höjd på textarean innan den börjar scrolla internt. */
const MAX_TEXTAREA_HEIGHT = 160

/**
 * `hero` = tomt läge, kompositören är sidans huvudperson och står mitt på ytan.
 * `docked` = konversationen pågår, kompositören har glidit ner till botten.
 */
export type ComposerVariant = 'hero' | 'docked'

interface ComposerProps {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  /** Skickning blockerad medan ett svar är på väg. */
  disabled: boolean
  isListening: boolean
  onStartVoice: () => void
  onStopVoice: () => void
  variant: ComposerVariant
  /**
   * Ägs av sidan: den nollställer höjden efter skickat meddelande och vid ny
   * konversation. Auto-resize under skrivandet sker här inne.
   */
  textareaRef: React.RefObject<HTMLTextAreaElement>
}

/**
 * Inmatningsraden — sidans huvudperson.
 *
 * Skicka-knappen använder `bg-blue-600`, vilket i det här systemet ÄR
 * varumärkesgrönt: sedan F5 pekar hela blå familjen på varumärkesskalan
 * (`blue: evenoScales.brand` i tailwind.config). Klassnamnet ser blått ut men
 * renderar `#1d5834`. Att i stället skriva `bg-brand` hade gett en annan
 * grön nyans (#1a6b3c) än appens alla andra primärknappar — konsekvensen
 * väger tyngre än att klassnamnet läser fel.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  isListening,
  onStartVoice,
  onStopVoice,
  variant,
  textareaRef,
}: ComposerProps) {
  const isHero = variant === 'hero'

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
    <div className={cn('w-full', isHero ? 'px-8' : 'border-line bg-surface border-t px-6 py-4')}>
      <div className={cn('mx-auto w-full', isHero ? 'max-w-2xl' : 'max-w-3xl')}>
        {isListening && (
          <div className="mb-2 flex items-center gap-2 text-[13px] text-red-500">
            <span className="animate-pulse">●</span>
            Lyssnar... Tala din fråga på svenska
          </div>
        )}
        <div
          className={cn(
            'border-line bg-surface flex items-end gap-3 border transition-all',
            'focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100',
            isHero ? 'rounded-3xl px-5 py-4 shadow-md' : 'rounded-2xl px-4 py-3',
          )}
        >
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={
              isHero ? 'Fråga om din portfölj, eller be mig göra något…' : 'Skriv ett meddelande…'
            }
            rows={isHero ? 2 : 1}
            className={cn(
              'text-ink flex-1 resize-none bg-transparent placeholder-gray-400 outline-none',
              isHero ? 'text-[15px] leading-relaxed' : 'text-[13.5px]',
            )}
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
              title="Skicka"
              className={cn(
                'flex items-center justify-center rounded-xl bg-blue-600 text-white transition-colors hover:bg-blue-700 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40',
                isHero ? 'h-10 w-10' : 'h-8 w-8',
              )}
            >
              <Send size={isHero ? 17 : 14} strokeWidth={2} />
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
