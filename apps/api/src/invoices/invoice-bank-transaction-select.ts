/**
 * VAD EN BANKTRANSAKTION FÅR BÄRA NÄR DEN LIGGER INBÄDDAD I EN FAKTURA.
 *
 * `GET /reconciliation/transactions` grindades till ACCOUNTANT+ i #440, och
 * skälet var fälten: betalarnamn, kontosaldo, `rawOcr` och aktörsfältet
 * `matchedBy`. Den grinden var verkningslös så länge `findOne` drog in hela
 * `BankTransaction`-raden via ett bart `include` — samma rader nåddes då genom
 * `GET /invoices/:id`, som är öppen för varje roll. En grind på VEM som får
 * anropa hjälper inte när VAD svaret bär inte är avgränsat.
 *
 * Skärningen är per fält, inte per rad. Frågan för varje kolumn: hör den till
 * BETALNINGEN AV DEN HÄR FAKTURAN, eller till BANKKONTOT den kom in på?
 *
 *   BEHÅLLS — hör till fakturan
 *     id           radidentitet, nyckel i UI-listan
 *     date         när betalningen kom in = fakturans betalningsdatum
 *     amount       beloppet som betalade just den här fakturan
 *     description  betalarnamnet som banken levererar det. På en MATCHED-rad
 *                  mot den här fakturan är det fakturans EGEN betalare — inget
 *                  den som redan ser fakturan inte vet.
 *     rawOcr       OCR-referensen på betalningen = den här fakturans OCR
 *
 *   TAS BORT — hör till bankkontot, inte till fakturan
 *     balance      kontosaldot vid transaktionen. Organisationens likviditet.
 *                  Den allvarligaste: den har ingenting med fakturan att göra.
 *     matchedBy    userId på den som matchade — aktörsfältet för en
 *                  MANAGER+-handling, samma sort som #440 grindade.
 *     matchedAt    tidsstämpel för samma matchningskörning
 *     createdAt    när raden importerades = importkörningens metadata
 *     externalId   bankens/aggregatorns transaktions-id (PSD2-källidentitet)
 *     dedupKey     cross-source-nyckel, rent avstämningsmaskineri
 *     organizationId  internt scopingfält utan klientanvändning
 *
 *   TAS BORT — bär ingen information i det här sammanhanget
 *     status              alltid MATCHED via where-klausulen
 *     invoiceId           FK tillbaka till fakturan man just hämtade
 *     matchedRentNoticeId XOR-partnern, alltid null när invoiceId är satt
 *     reference           bankens fria referensfält. Inte känsligt, men ingen
 *                         yta läser det — utelämnas på dataminimering.
 *
 * `select` och inte `include`: ett `include` släpper dessutom igenom
 * relationerna (`rentNoticePayment`, `invoicePayment`) om någon lägger till en,
 * och det är precis så den här läckan uppstod.
 *
 * Konstanten är INTE en allmän "säker vy" av BankTransaction — den är
 * fakturakontextens projektion. Den fulla raden har sin egen grindade endpoint.
 */
export const SAFE_INVOICE_BANK_TRANSACTION_SELECT = {
  id: true,
  date: true,
  amount: true,
  description: true,
  rawOcr: true,
} as const
