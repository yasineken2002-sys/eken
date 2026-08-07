/**
 * DRIFTVAKT: får `Invoice` en nedskrivningsväg måste C:s grind följa med.
 *
 * C (nedskriven fordran kan inte annulleras) lades BARA i `cancelNotice`, och det
 * var rätt — men slutsatsen vilar på ett tillstånd i schemat, inte på en princip:
 *
 *   MÄTT PÅ main bbd156a: `Invoice` saknar `probableLossAt`, `writtenOffAt` och
 *   `collectionStage` helt. `RentBadDebtService` rör bara `rentNotice`,
 *   `journalEntry` och `user` — aldrig `invoice`. Hela bad-debt-ytan är två
 *   avi-scopade endpoints (`avisering.controller.ts`). En faktura kan därför
 *   aldrig hamna i det tillstånd C spärrar mot, och en spegling i
 *   `invoices.service.ts` hade varit en grind mot något som inte kan inträffa.
 *
 * Den dagen någon ger `Invoice` en kravtrappa eller en kundförlust-väg upphör det
 * att gälla — och `transitionStatus`-grenen för VOID kallar
 * `reverseJournalEntryForInvoice`, som speglar originalposten lika ovillkorligt
 * som avi-syskonet. Hålet återuppstår då i syskonsystemet, tyst.
 *
 * Det här testet är därför inte ett test av beteende utan en SPÄRR MOT DRIFT: det
 * faller i samma PR som fältet införs, med en instruktion om vad som måste följa
 * med. Läxan är #288/#326 — en fix på ena sidan av ett syskonpar säger ingenting
 * om den andra.
 *
 * Oraklet är Prisma-datamodellen, inte en handskriven lista över fält. En
 * handskriven lista hade blivit ännu en andra sanning vid sidan av schemat.
 */

import { Prisma } from '@prisma/client'

const NEDSKRIVNINGSFÄLT = ['probableLossAt', 'writtenOffAt', 'collectionStage']

describe('driftvakt: Invoice har ingen nedskrivnings-/kravtrappeyta', () => {
  const invoice = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Invoice')
  const rentNotice = Prisma.dmmf.datamodel.models.find((m) => m.name === 'RentNotice')

  it('modellerna går att läsa ur datamodellen (annars bevakar testet ingenting)', () => {
    // Positiv kontroll: hittar uppslaget inte modellerna blir svepet nedan tomt
    // och passerar tyst — exakt den sortens grönt utan täckning som inte får
    // förväxlas med ett bevis.
    expect(invoice).toBeDefined()
    expect(rentNotice).toBeDefined()
  })

  it('RentNotice HAR fälten — annars mäter svepet fel sak', () => {
    // Diskriminerande kontroll: bevisar att fältnamnen stavas som de gör i
    // schemat. Vore de felstavade skulle Invoice-svepet nedan vara grönt av fel
    // skäl, och vakten hade aldrig fällt när den skulle.
    const fält = (rentNotice?.fields ?? []).map((f) => f.name)
    for (const namn of NEDSKRIVNINGSFÄLT) {
      expect(fält).toContain(namn)
    }
  })

  it.each(NEDSKRIVNINGSFÄLT)('Invoice saknar fortfarande %s', (namn) => {
    const fält = (invoice?.fields ?? []).map((f) => f.name)

    // FALLER DET HÄR: fältet har införts på Invoice. Då måste samma grind som i
    // `AviseringService.cancelNotice` in i `InvoicesService.transitionStatus`
    // VOID-grenen — både som förläsning och som villkor i status-claimen — i
    // SAMMA PR. Utan den krediterar VOID 1510 en andra gång på en faktura vars
    // fordran redan skrivits ned. Ta inte bort raden här; lägg till grinden.
    expect(fält).not.toContain(namn)
  })
})
