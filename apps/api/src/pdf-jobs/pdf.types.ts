// Typer för PDF-jobbkön (FIX 5).
//
// Tunga PDF-renderingar (Puppeteer) flyttas från HTTP-requesten till en
// Bull-kö så att "skicka"-flöden svarar direkt (202) i stället för att
// blockera tills Chromium renderat klart. Nedladdnings-endpoints (GET .../pdf)
// förblir synkrona — de returnerar filen direkt till en väntande användare.

export const QUEUE_PDF = 'pdf'

/**
 * Diskriminerad union — ett `kind` per köat flöde. Payloaden innehåller bara
 * ID:n (inga Buffrar) så jobbet serialiseras smidigt till Redis; workern
 * hämtar all data på nytt när den kör.
 */
export type PdfJobPayload =
  | { kind: 'avisering-send'; organizationId: string; noticeId: string }
  | { kind: 'collections-export'; organizationId: string; invoiceId: string }
  | { kind: 'collections-bulk-export'; organizationId: string; invoiceIds: string[] }
  | { kind: 'invoice-send'; organizationId: string; invoiceId: string; actorId: string }
  | { kind: 'platform-invoice-send'; platformInvoiceId: string }

export type PdfJobKind = PdfJobPayload['kind']
