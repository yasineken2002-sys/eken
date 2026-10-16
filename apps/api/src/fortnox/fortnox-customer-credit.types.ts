import type { FortnoxAccountRole } from '@eken/shared'

/** Serverhärledda lokala radidentiteter; ett prefix eller kundangivet konto är inget ursprungsbevis. */
export interface CustomerCreditExportAnchor {
  journalEntryLineId: string
  originJournalEntryId: string
  originJournalEntryLineId: string
  role: FortnoxAccountRole
}

export interface CustomerCreditExportOrigins {
  kind: 'RECEIPT' | 'APPLICATION' | 'REFUND'
  creditId: string
  eventId: string
  anchors: CustomerCreditExportAnchor[]
}
