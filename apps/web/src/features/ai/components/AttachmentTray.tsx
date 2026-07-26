import { AnimatePresence, motion } from 'framer-motion'
import { AlertCircle, FileText, Image as ImageIcon, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { formatBytes, type PendingAttachment } from '../hooks/useAttachments'

interface AttachmentTrayProps {
  attachments: PendingAttachment[]
  onRemove: (localId: string) => void
}

/**
 * Bilagorna ovanför inmatningsraden.
 *
 * Varje kort visar tre saker användaren behöver: VAD filen är (miniatyr för
 * bild, ikon för PDF), VILKEN den är (filnamnet, avkortat men aldrig gömt) och
 * OM den är skickbar (storlek + sidantal när den är klar, spinner medan den
 * laddas, felskälet om något gick fel).
 *
 * Sidantalet kommer från serverns räkning (B3) — inte en gissning här.
 */
export function AttachmentTray({ attachments, onRemove }: AttachmentTrayProps) {
  if (attachments.length === 0) return null

  return (
    <div className="mb-2.5 flex flex-wrap gap-2">
      <AnimatePresence initial={false}>
        {attachments.map((attachment) => (
          <motion.div
            key={attachment.localId}
            layout
            initial={{ opacity: 0, scale: 0.94, y: 4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: 4 }}
            transition={{ duration: 0.15 }}
            className={cn(
              'group relative flex items-center gap-2.5 rounded-xl border py-2 pl-2.5 pr-8',
              // Felkort får vara bredare: skälet MÅSTE gå att läsa, och det är
              // en hel mening ("PDF:en har 640 sidor (max 600)"). Ett namn kan
              // avkortas — en instruktion kan inte.
              attachment.status === 'error'
                ? 'max-w-[22rem] border-red-200 bg-red-50'
                : 'border-line bg-surface max-w-[15rem] shadow-sm',
            )}
          >
            <Thumbnail attachment={attachment} />

            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  'truncate text-[12.5px] font-medium',
                  attachment.status === 'error' ? 'text-red-700' : 'text-gray-700',
                )}
                title={attachment.filename}
              >
                {attachment.filename}
              </p>
              <p
                className={cn(
                  'text-[11px]',
                  // Statusraden avkortas, felskälet radbryts. Ett trunkerat
                  // "Bara PDF, JPG, PNG och W…" hjälper ingen.
                  attachment.status === 'error'
                    ? 'break-words text-red-600'
                    : 'truncate text-gray-500',
                )}
                title={describe(attachment)}
              >
                {describe(attachment)}
              </p>
            </div>

            <button
              type="button"
              onClick={() => onRemove(attachment.localId)}
              aria-label={`Ta bort ${attachment.filename}`}
              title="Ta bort"
              className={cn(
                'absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-md transition-colors',
                attachment.status === 'error'
                  ? 'text-red-500 hover:bg-red-100'
                  : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600',
              )}
            >
              <X size={13} strokeWidth={2} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

/** Miniatyr för bild, ikon annars. Spinner medan uppladdningen pågår. */
function Thumbnail({ attachment }: { attachment: PendingAttachment }) {
  if (attachment.status === 'uploading') {
    return (
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-gray-100">
        <Loader2 size={15} className="animate-spin text-gray-400" />
      </div>
    )
  }

  if (attachment.status === 'error') {
    return (
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-red-100">
        <AlertCircle size={15} strokeWidth={1.8} className="text-red-600" />
      </div>
    )
  }

  if (attachment.previewUrl) {
    return (
      <img
        src={attachment.previewUrl}
        alt=""
        className="border-line h-9 w-9 flex-shrink-0 rounded-lg border object-cover"
      />
    )
  }

  const isImage = attachment.uploaded?.kind === 'image'
  const Icon = isImage ? ImageIcon : FileText
  return (
    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-blue-50">
      <Icon size={15} strokeWidth={1.8} className="text-blue-600" />
    </div>
  )
}

/** Andra raden på kortet: status, eller storlek + sidantal när den är klar. */
function describe(attachment: PendingAttachment): string {
  if (attachment.status === 'uploading') return 'Laddar upp…'
  if (attachment.status === 'error') return attachment.error ?? 'Kunde inte laddas upp'

  const uploaded = attachment.uploaded
  if (!uploaded) return formatBytes(attachment.sizeBytes)

  const size = formatBytes(uploaded.sizeBytes)
  if (uploaded.pageCount === null) return size
  return `${size} · ${uploaded.pageCount} ${uploaded.pageCount === 1 ? 'sida' : 'sidor'}`
}
