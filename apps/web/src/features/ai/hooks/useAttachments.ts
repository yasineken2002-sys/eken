import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  ATTACHMENT_LIMITS,
  deleteAttachment,
  uploadAttachment,
  type AiAttachment,
} from '../api/ai.api'

/**
 * En bilaga i kompositören, i något av tre lägen.
 *
 * `uploading` → `ready` (servern har filen och gav ett id) eller `error`.
 * Ett `error`-kort är INTE en bilaga — det är ett misslyckat försök, och det
 * ligger kvar synligt tills användaren tar bort det. Skälet står vid
 * `blockingReason` nedan.
 */
export interface PendingAttachment {
  /** Lokalt id — finns direkt, till skillnad från serverns. */
  localId: string
  filename: string
  sizeBytes: number
  /** Webbläsarens gissning. Servern detekterar den sanna typen. */
  clientMimeType: string
  status: 'uploading' | 'ready' | 'error'
  /** Sätts när servern svarat — det som skickas som `attachmentIds`. */
  uploaded?: AiAttachment
  error?: string
  /** Lokal object-URL för bildförhandsvisning; frigörs vid borttagning. */
  previewUrl?: string
}

let counter = 0
const nextLocalId = () => `att-${++counter}`

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
}

export { formatBytes }

/**
 * Bilagorna i kompositören.
 *
 * Hooken äger uppladdningen, förhandsgranskningen och städningen. Sidan äger
 * bara sändningen — den frågar efter `readyIds` när meddelandet skickas.
 *
 * FÖRVALIDERINGEN här (typ, storlek, antal) är en snabbhet, inte ett skydd:
 * servern validerar magiska byten, sidantal och totalstorlek oavsett. Poängen
 * är att en användare som drar in en .docx ska få veta det direkt i stället för
 * efter att 8 MB laddats upp.
 */
export function useAttachments() {
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  // Läses i callbacks som annars hade sett en gammal state-snapshot.
  const attachmentsRef = useRef<PendingAttachment[]>([])
  attachmentsRef.current = attachments

  const patch = useCallback((localId: string, changes: Partial<PendingAttachment>) => {
    setAttachments((prev) => prev.map((a) => (a.localId === localId ? { ...a, ...changes } : a)))
  }, [])

  const addFiles = useCallback(
    (files: File[], conversationId?: string) => {
      if (files.length === 0) return

      const current = attachmentsRef.current
      const room = ATTACHMENT_LIMITS.maxPerMessage - current.length
      if (room <= 0) {
        toast.error(`Högst ${ATTACHMENT_LIMITS.maxPerMessage} bilagor per meddelande`)
        return
      }
      if (files.length > room) {
        // Ordalydelsen skiljer på "du har redan några" och "du valde för många
        // på en gång" — annars läser det första fallet som nonsens ("bara 5
        // bilagor till får plats" när brickan är tom).
        toast.error(
          current.length === 0
            ? `Högst ${ATTACHMENT_LIMITS.maxPerMessage} bilagor per meddelande — de ${room} första togs med`
            : `Bara ${room} ${room === 1 ? 'bilaga' : 'bilagor'} till får plats (högst ${ATTACHMENT_LIMITS.maxPerMessage} per meddelande)`,
        )
      }

      for (const file of files.slice(0, room)) {
        const localId = nextLocalId()
        const isImage = file.type.startsWith('image/')
        const entry: PendingAttachment = {
          localId,
          filename: file.name,
          sizeBytes: file.size,
          clientMimeType: file.type,
          status: 'uploading',
          ...(isImage ? { previewUrl: URL.createObjectURL(file) } : {}),
        }

        // Förvalidering — visas som ett felkort utan att filen skickas.
        const rejection = validateLocally(file)
        if (rejection) {
          setAttachments((prev) => [...prev, { ...entry, status: 'error', error: rejection }])
          continue
        }

        setAttachments((prev) => [...prev, entry])

        void uploadAttachment(file, conversationId)
          .then((uploaded) => patch(localId, { status: 'ready', uploaded }))
          .catch((err: unknown) => {
            // Serverns eget meddelande är det bästa vi har — det säger
            // "PDF:en har 640 sidor (max 600)" eller "Filinnehållet kunde inte
            // verifieras", vilket är mer användbart än något vi hittar på.
            patch(localId, { status: 'error', error: serverMessage(err) })
          })
      }
    },
    [patch],
  )

  const remove = useCallback((localId: string) => {
    const target = attachmentsRef.current.find((a) => a.localId === localId)
    setAttachments((prev) => prev.filter((a) => a.localId !== localId))
    if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)

    // Ta bort serverns kopia också. Fire-and-forget: misslyckas det städar
    // TTL-cronen bort den ändå inom ett dygn, och användaren ska inte hindras
    // från att ta bort ett kort ur sitt UI av ett nätverksfel.
    if (target?.uploaded) {
      void deleteAttachment(target.uploaded.id).catch(() => undefined)
    }
  }, [])

  /**
   * Nollställ efter ett skickat meddelande. Serverns bilagor är konsumerade nu
   * och kan inte skickas igen, så korten MÅSTE bort — annars hade nästa
   * meddelande avvisats med "redan skickade".
   */
  const clear = useCallback(() => {
    for (const a of attachmentsRef.current) {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
    }
    setAttachments([])
  }, [])

  const readyIds = attachments
    .filter((a) => a.status === 'ready' && a.uploaded)
    .map((a) => a.uploaded!.id)

  /**
   * Varför sändning är blockerad, eller null om den är fri.
   *
   * Två fall, och båda finns för att INGENTING ska tappas tyst:
   *  • En uppladdning är på väg — hade vi skickat nu gått meddelandet iväg utan
   *    sin bilaga.
   *  • Ett felkort ligger kvar — att skicka då hade tyst hoppat över filen
   *    användaren tror att hen bifogat. Kortet måste bort medvetet.
   */
  const blockingReason = attachments.some((a) => a.status === 'uploading')
    ? 'Väntar på att bilagan laddas upp…'
    : attachments.some((a) => a.status === 'error')
      ? 'Ta bort bilagan som inte kunde laddas upp först'
      : null

  return { attachments, addFiles, remove, clear, readyIds, blockingReason }
}

function validateLocally(file: File): string | null {
  if (file.size === 0) return 'Filen är tom'
  const accepted = ATTACHMENT_LIMITS.acceptedMimeTypes as readonly string[]
  if (file.type && !accepted.includes(file.type)) {
    return 'Bara PDF, JPG, PNG och WEBP kan skickas till assistenten'
  }
  const isImage = file.type.startsWith('image/')
  const max = isImage ? ATTACHMENT_LIMITS.maxImageBytes : ATTACHMENT_LIMITS.maxDocumentBytes
  if (file.size > max) {
    return `För stor (${formatBytes(file.size)}, max ${formatBytes(max)})`
  }
  return null
}

/** Plockar ut serverns svenska felmeddelande ur ett axios-fel. */
function serverMessage(err: unknown): string {
  const body = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data
  return body?.error?.message ?? 'Kunde inte ladda upp filen'
}
