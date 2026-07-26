import { useRef, useState } from 'react'
import { Send, Mic, MicOff, Paperclip } from 'lucide-react'
import { AttachmentTray } from './AttachmentTray'
import { ToolMenu } from './ToolMenu'
import { cn } from '@/lib/cn'
import { ATTACHMENT_ACCEPT, type ToolCatalogEntry } from '../api/ai.api'
import type { PendingAttachment } from '../hooks/useAttachments'

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
  /** Verktygskatalogen från backend — driver menyn. */
  toolCatalog: ToolCatalogEntry[] | undefined
  /** Val i verktygsmenyn. Fyller bara rutan; skickar aldrig. */
  onSelectTool: (entry: ToolCatalogEntry) => void
  /** Bilagor på väg in i meddelandet (B4). */
  attachments: PendingAttachment[]
  onAddFiles: (files: File[]) => void
  onRemoveAttachment: (localId: string) => void
  /**
   * Varför sändning är blockerad av bilagorna, eller null. Visas som titel på
   * skicka-knappen så en avstängd knapp aldrig är oförklarad.
   */
  attachmentBlockingReason: string | null
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
 *
 * TRE VÄGAR IN FÖR EN BILAGA (B4), för att folk gör olika: gemet öppnar
 * filväljaren, Ctrl+V klistrar in en skärmdump, och drag-och-släpp tar en fil
 * från skrivbordet. Alla tre går till samma `onAddFiles`.
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
  toolCatalog,
  onSelectTool,
  attachments,
  onAddFiles,
  onRemoveAttachment,
  attachmentBlockingReason,
  textareaRef,
}: ComposerProps) {
  const isHero = variant === 'hero'
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  // Räknare, inte boolean: dragenter/dragleave fyras även när pekaren rör sig
  // mellan barnelement. Med en boolean slocknar markeringen så fort man passerar
  // textarean, mitt i draget.
  const dragDepth = useRef(0)

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

  /**
   * Inklistring. Bara filer plockas upp — klistrar man in TEXT ska den hamna i
   * textarean som vanligt, så `preventDefault` sker enbart när det faktiskt
   * fanns en fil i urklippet.
   */
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files)
    if (files.length === 0) return
    e.preventDefault()
    onAddFiles(files)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    dragDepth.current = 0
    setIsDragging(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) onAddFiles(files)
  }

  const openFilePicker = () => fileInputRef.current?.click()

  return (
    <div className={cn('w-full', isHero ? 'px-8' : 'border-line bg-surface border-t px-6 py-4')}>
      <div className={cn('mx-auto w-full', isHero ? 'max-w-2xl' : 'max-w-3xl')}>
        {isListening && (
          <div className="mb-2 flex items-center gap-2 text-[13px] text-red-500">
            <span className="animate-pulse">●</span>
            Lyssnar... Tala din fråga på svenska
          </div>
        )}

        <AttachmentTray attachments={attachments} onRemove={onRemoveAttachment} />

        {/* Släppzonen är hela inmatningsytan, inte en egen ruta: man siktar på
            rutan man skriver i. `dragDepth` räknar in/ut så markeringen inte
            blinkar när pekaren passerar barnelement. */}
        <div
          onDragEnter={(e) => {
            e.preventDefault()
            dragDepth.current++
            if (e.dataTransfer.types.includes('Files')) setIsDragging(true)
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={(e) => {
            e.preventDefault()
            dragDepth.current--
            if (dragDepth.current <= 0) {
              dragDepth.current = 0
              setIsDragging(false)
            }
          }}
          onDrop={handleDrop}
          className={cn(
            'border-line bg-surface flex items-end gap-3 border transition-all',
            'focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100',
            isDragging && 'border-blue-400 bg-blue-50/60 ring-2 ring-blue-100',
            isHero ? 'rounded-3xl px-5 py-4 shadow-md' : 'rounded-2xl px-4 py-3',
          )}
        >
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={
              isDragging
                ? 'Släpp filen här…'
                : isHero
                  ? 'Fråga om din portfölj, eller be mig göra något…'
                  : 'Skriv ett meddelande…'
            }
            rows={isHero ? 2 : 1}
            className={cn(
              'text-ink flex-1 resize-none bg-transparent placeholder-gray-400 outline-none',
              isHero ? 'text-[15px] leading-relaxed' : 'text-[13.5px]',
            )}
            style={{ maxHeight: `${MAX_TEXTAREA_HEIGHT}px` }}
          />
          <div className="flex flex-shrink-0 items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ATTACHMENT_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? [])
                if (files.length > 0) onAddFiles(files)
                // Nollställ så samma fil kan väljas igen direkt efteråt —
                // annars fyras inget change-event andra gången.
                e.target.value = ''
              }}
            />
            <button
              type="button"
              onClick={openFilePicker}
              title="Bifoga PDF eller bild"
              aria-label="Bifoga fil"
              className="rounded-lg p-2 text-gray-400 transition-colors hover:text-gray-600"
            >
              <Paperclip size={isHero ? 18 : 16} strokeWidth={1.8} />
            </button>
            <ToolMenu catalog={toolCatalog} onSelect={onSelectTool} compact={!isHero} />
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
              disabled={!value.trim() || disabled || attachmentBlockingReason !== null}
              // En avstängd knapp ska aldrig vara oförklarad: säger bilagorna
              // nej är det deras skäl som visas, inte ett generiskt "Skicka".
              title={attachmentBlockingReason ?? 'Skicka'}
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
          {attachmentBlockingReason ??
            'Eveno AI kan utföra åtgärder — åtgärder kräver alltid din bekräftelse.'}
        </p>
      </div>
    </div>
  )
}
