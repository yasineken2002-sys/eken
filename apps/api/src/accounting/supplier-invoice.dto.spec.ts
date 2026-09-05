/**
 * KROPPEN WEBBEN FAKTISKT SKICKAR — mot den riktiga ValidationPipe.
 *
 * ── VARFÖR DEN HÄR FILEN FINNS ──────────────────────────────────────────────
 *
 * De andra proven anropar tjänsten och radbyggarna direkt med ett komplett
 * params-objekt. De går alltså ALDRIG genom `CreateSupplierInvoiceDto`, och kan
 * per konstruktion inte se att frontend och DTO:n är oense om vilka fält som
 * finns. Kontraktet är skrivet på två ställen — `class-validator`-dekoratorer i
 * API:t och ett handskrivet interface i webben — och det är i glappet mellan dem
 * felet bor.
 *
 * Uppmätt: en tidigare version av modalen skickade inget `vatAmount` medan DTO:n
 * krävde det. Varje registrering hade svarat 400, och samtliga 37 gröna prov i
 * de andra filerna hade fortsatt vara gröna.
 *
 * Pipen konfigureras med SAMMA flaggor som `main.ts` (`whitelist`,
 * `forbidNonWhitelisted`, `transform`). Avviker de här är provet en attrapp av
 * produktionen i stället för en mätning av den.
 *
 * ── VAD DEN HÄR FILEN INTE KAN SE ───────────────────────────────────────────
 *
 * Kroppen nedan är en HANDSKRIVEN KOPIA av det modalen bygger, inte modalens
 * egen kod. Ändrar någon modalen till att sluta skicka ett fält märker den här
 * filen ingenting — den kan bara mäta åt ANDRA hållet: att DTO:n fortsätter
 * godta den form webben skickar. Det är också den riktning felet gick i (DTO:n
 * krävde mer än modalen skickade), och `UTAN vatAmount går igenom` är provet som
 * fäller om kravet återinförs.
 *
 * Den andra riktningen ägs av typerna: `SkapaLeverantorsfakturaInput` i
 * `accounting.api.ts` är webbens kontrakt, och den som tar bort ett fält därifrån
 * bryter modalens typkontroll. Ett verkligt gemensamt schema i `@eken/shared`
 * hade gjort båda riktningarna till ett kompileringsfel — det är rätt åtgärd och
 * en större än den här PR:en.
 */

import { ValidationPipe } from '@nestjs/common'
import { VAT_RATES } from '@eken/shared'
import { CreateSupplierInvoiceDto, PaySupplierInvoiceDto } from './dto/supplier-invoice.dto'

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })

const validera = (kropp: unknown, metatype: unknown = CreateSupplierInvoiceDto) =>
  pipe.transform(kropp, { type: 'body', metatype: metatype as never })

/**
 * Exakt den kropp `NewSupplierInvoiceModal` bygger i `registrera()`. Ändras
 * modalen utan att den här ändras ska något här falla — det är hela poängen.
 */
const kroppenFranModalen = (över: Record<string, unknown> = {}) => ({
  supplierName: 'Rörjouren AB',
  invoiceNumber: 'F-100',
  description: 'Stambyte trapphus B',
  invoiceDate: '2026-09-01',
  dueDate: '2026-10-01',
  expenseAccount: 5070,
  amount: 1250,
  vatRate: 25,
  vatAmount: 250,
  ...över,
})

describe('CreateSupplierInvoiceDto — kroppen webben skickar', () => {
  it('modalens kropp går igenom pipen', async () => {
    await expect(validera(kroppenFranModalen())).resolves.toMatchObject({
      supplierName: 'Rörjouren AB',
      amount: 1250,
      vatAmount: 250,
    })
  })

  it.each(VAT_RATES)('momssats %i %% godtas', async (sats) => {
    // Dropdownen erbjuder exakt VAT_RATES. En sats som listan visar men DTO:n
    // avvisar hade blivit ett 422 på ett val användaren fick göra.
    await expect(
      validera(kroppenFranModalen({ vatRate: sats, vatAmount: 0 })),
    ).resolves.toBeDefined()
  })

  it('UTAN vatAmount går igenom — servern räknar då själv', async () => {
    const { vatAmount, ...utan } = kroppenFranModalen()
    void vatAmount
    await expect(validera(utan)).resolves.toBeDefined()
  })

  it('UTAN invoiceNumber går igenom — fältet är valfritt', async () => {
    const { invoiceNumber, ...utan } = kroppenFranModalen()
    void invoiceNumber
    await expect(validera(utan)).resolves.toBeDefined()
  })

  // ── NEGATIVKONTROLLER ────────────────────────────────────────────────────
  // Utan dem kan provet ovan vara grönt av att pipen inte gör något alls.

  it('KANARIEFÅGEL: ett OKÄNT fält fälls — pipen är verkligen påslagen', async () => {
    await expect(validera(kroppenFranModalen({ hittepa: 1 }))).rejects.toThrow()
  })

  it('saknat obligatoriskt fält fälls', async () => {
    const { supplierName, ...utan } = kroppenFranModalen()
    void supplierName
    await expect(validera(utan)).rejects.toThrow()
  })

  it('momssats utanför VAT_RATES fälls', async () => {
    await expect(validera(kroppenFranModalen({ vatRate: 17 }))).rejects.toThrow()
  })

  it('negativt belopp fälls', async () => {
    await expect(validera(kroppenFranModalen({ amount: -5 }))).rejects.toThrow()
  })

  it('kontonummer utanför BAS-intervallet fälls', async () => {
    await expect(validera(kroppenFranModalen({ expenseAccount: 999 }))).rejects.toThrow()
  })
})

describe('PaySupplierInvoiceDto', () => {
  it('betalningsdatum godtas', async () => {
    await expect(validera({ paidDate: '2026-09-30' }, PaySupplierInvoiceDto)).resolves.toBeDefined()
  })

  it('saknat datum fälls — verifikatet måste ha ett datum', async () => {
    await expect(validera({}, PaySupplierInvoiceDto)).rejects.toThrow()
  })
})
