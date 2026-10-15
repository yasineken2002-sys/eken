type ReferenceField =
  | { kind: 'neutral' }
  | { kind: 'notice'; noticeNumber: string }
  | { kind: 'ocr'; ocr: string }
  | { kind: 'unsupported' }

export type CustomerCreditReference =
  | { kind: 'none' }
  | { kind: 'blocked' }
  | { kind: 'notice'; noticeNumber: string; ocr: string | null }

function parseField(value: string | null): ReferenceField {
  const text = value?.trim() ?? ''
  if (!text || /^(?:Hyra|Inbetalning|Betalning|Bankgiro|Autogiro)$/i.test(text)) {
    return { kind: 'neutral' }
  }
  const notice = text.match(
    /^(?:(?:Hyra|Inbetalning|Betalning)\s+)?(AVI-\d{4}-(?:0[1-9]|1[0-2])-\d{4})$/i,
  )
  if (notice?.[1]) return { kind: 'notice', noticeNumber: notice[1].toUpperCase() }
  const ocr = text.match(/^(?:OCR\s*:?\s*)?(\d{4,20})$/i)
  if (ocr?.[1]) return { kind: 'ocr', ocr: ocr[1] }
  return { kind: 'unsupported' }
}

/**
 * Ett kundtillgodo kräver en hel, entydig avireferens; första regexträffen i
 * fritext är inte ett belägg. Övriga fält får bara vara samma avi, en neutral
 * banketikett eller ett OCR som prövas mot den valda avins identitet under lås.
 *
 * `none` behåller befintlig OCR-/fuzzy-väg. `blocked` får aldrig falla vidare
 * till en annan månad. Ingen OCR-proveniens rekonstrueras här: exempelvis
 * råvärdet 2026 från en äldre extraktion av AVI-2026-09-0001 bevaras och måste
 * fortfarande stämma med målidentiteten. Det får inte tyst kastas bort.
 */
export function resolveCustomerCreditReference(transaction: {
  description: string | null
  reference: string | null
  rawOcr: string | null
}): CustomerCreditReference {
  const values = [transaction.description, transaction.reference]
  if (!values.some((value) => /AVI-/i.test(value ?? ''))) return { kind: 'none' }

  const fields = values.map(parseField)
  if (fields.some((field) => field.kind === 'unsupported')) return { kind: 'blocked' }

  const notices = new Set(
    fields.flatMap((field) => (field.kind === 'notice' ? [field.noticeNumber] : [])),
  )
  const [noticeNumber] = notices
  if (notices.size !== 1 || !noticeNumber) return { kind: 'blocked' }

  const ocrs = new Set(fields.flatMap((field) => (field.kind === 'ocr' ? [field.ocr] : [])))
  if (transaction.rawOcr !== null) {
    if (!/^\d{4,20}$/.test(transaction.rawOcr)) return { kind: 'blocked' }
    ocrs.add(transaction.rawOcr)
  }
  if (ocrs.size > 1) return { kind: 'blocked' }

  return { kind: 'notice', noticeNumber, ocr: [...ocrs][0] ?? null }
}
