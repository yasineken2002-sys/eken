/**
 * KONTRAKTET I RUNTIME — schemat och DTO:n ska säga SAMMA SAK.
 *
 * ── VAD SOM PRÖVAS, OCH VARFÖR DET ÄR MER ÄN #795:s PROV ────────────────────
 *
 * `supplier-invoice.dto.spec.ts` (#795) skriver kroppen FÖR HAND och kan därför
 * bara mäta att DTO:n godtar den form webben skickade den dagen. Filen säger det
 * själv i sitt eget stycke om vad den inte kan se.
 *
 * Den här filen mäter i stället PARITETEN mellan de två beskrivningarna: samma
 * nyttolast körs genom BÅDA — Zod-schemat i @eken/shared och DTO:n via riktig
 * ValidationPipe — och de måste ge samma svar. En form som schemat godtar men
 * DTO:n avvisar är ett 400 för en användare som gjorde allt rätt; en form som
 * DTO:n godtar men schemat avvisar är en regel webben tror gäller men som inte
 * gör det.
 *
 * Kompileringstidens halva (`implements` + `SammaNycklar`) fångar NYCKLAR.
 * Den här fångar GRÄNSERNA — maxlängd, intervall, obligatoriskhet — som lever i
 * class-validator-dekoratorerna och i Zod-reglerna var för sig.
 *
 * ── VAD DEN INTE KAN SE ─────────────────────────────────────────────────────
 *
 * Bara de fall som räknas upp nedan. Det är inte en egenskapsbaserad prövning
 * av hela värdemängden, och en gräns som skiljer sig först vid ett värde ingen
 * skrev ned syns inte. Uppräkningen är därför medvetet lagd på de gränser som
 * FAKTISKT står i båda beskrivningarna (konto­intervallet, minsta antal rader,
 * beloppets nedre gräns, obligatoriska fält) — inte på ett stickprov.
 *
 * Pipen konfigureras med SAMMA flaggor som `main.ts`.
 */

import { ValidationPipe } from '@nestjs/common'
import {
  CreateExpenseSchema,
  CreateJournalEntrySchema,
  CreateSupplierInvoiceSchema,
} from '@eken/shared'
import { CreateJournalEntryDto } from './dto/create-journal-entry.dto'
import { CreateExpenseDto } from './dto/create-expense.dto'
import { CreateSupplierInvoiceDto } from './dto/supplier-invoice.dto'
import { CreateMeterSchema, RegisterPaymentSchema } from '@eken/shared'
import { RegisterPaymentDto } from '../invoices/dto/register-payment.dto'
import { CreateMeterDto } from '../consumption/dto/create-meter.dto'
import { KONTRAKTSREGISTER } from '../common/contract/schema-dto-registry'
import type { ZodType } from 'zod'

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })

async function pipenGodtar(metatype: unknown, kropp: unknown): Promise<boolean> {
  try {
    await pipe.transform(kropp, { type: 'body', metatype: metatype as never })
    return true
  } catch {
    return false
  }
}

const schematGodtar = (schema: ZodType<unknown>, kropp: unknown) => schema.safeParse(kropp).success

/**
 * Kärnan: kör kroppen genom båda och kräv samma svar. Meddelandet skriver ut
 * VILKEN sida som sa vad — annars vet man bara att de är oense.
 */
async function paritet(
  namn: string,
  schema: ZodType<unknown>,
  metatype: unknown,
  kropp: unknown,
  vantat: boolean,
) {
  const zod = schematGodtar(schema, kropp)
  const dto = await pipenGodtar(metatype, kropp)
  expect({ fall: namn, zod, dto }).toEqual({ fall: namn, zod: vantat, dto: vantat })
}

// ── Giltiga nyttolaster, en per endpoint ────────────────────────────────────

const verifikat = {
  date: '2026-09-01',
  description: 'Omföring mellan konton',
  lines: [
    { accountNumber: 1930, debit: 100 },
    { accountNumber: 1510, credit: 100 },
  ],
  idempotencyKey: 'abc',
}

const utgift = {
  date: '2026-09-01',
  description: 'Reparation trapphus',
  supplier: 'Rörjouren AB',
  amount: 1250,
  vatRate: 25,
  vatAmount: 250,
  accountNumber: 5070,
  idempotencyKey: 'abc',
}

const leverantorsfaktura = {
  supplierName: 'Rörjouren AB',
  invoiceNumber: 'F-100',
  description: 'Stambyte trapphus B',
  invoiceDate: '2026-09-01',
  dueDate: '2026-10-01',
  expenseAccount: 5070,
  amount: 1250,
  vatRate: 25,
  vatAmount: 250,
}

const utan = <T extends object>(o: T, nyckel: keyof T) => {
  const kopia = { ...o }
  delete kopia[nyckel]
  return kopia
}

describe('verifikat — schema och DTO ger samma svar', () => {
  it('giltig kropp godtas av båda', () =>
    paritet('giltig', CreateJournalEntrySchema, CreateJournalEntryDto, verifikat, true))

  it('EN rad avvisas av båda — minst två krävs', () =>
    paritet(
      'en rad',
      CreateJournalEntrySchema,
      CreateJournalEntryDto,
      { ...verifikat, lines: [verifikat.lines[0]] },
      false,
    ))

  it('saknad beskrivning avvisas av båda', () =>
    paritet(
      'utan description',
      CreateJournalEntrySchema,
      CreateJournalEntryDto,
      utan(verifikat, 'description'),
      false,
    ))

  it('konto utanför BAS-intervallet avvisas av båda', () =>
    paritet(
      'konto 999',
      CreateJournalEntrySchema,
      CreateJournalEntryDto,
      { ...verifikat, lines: [{ accountNumber: 999, debit: 1 }, verifikat.lines[1]] },
      false,
    ))

  it('UTAN idempotencyKey godtas av båda — servern har en egen reserv', () =>
    paritet(
      'utan nyckel',
      CreateJournalEntrySchema,
      CreateJournalEntryDto,
      utan(verifikat, 'idempotencyKey'),
      true,
    ))
})

describe('utgift — schema och DTO ger samma svar', () => {
  it('giltig kropp godtas av båda', () =>
    paritet('giltig', CreateExpenseSchema, CreateExpenseDto, utgift, true))

  it('belopp noll avvisas av båda', () =>
    paritet('belopp 0', CreateExpenseSchema, CreateExpenseDto, { ...utgift, amount: 0 }, false))

  it('saknat konto avvisas av båda', () =>
    paritet(
      'utan accountNumber',
      CreateExpenseSchema,
      CreateExpenseDto,
      utan(utgift, 'accountNumber'),
      false,
    ))

  it('UTAN leverantör godtas av båda — fältet är valfritt', () =>
    paritet('utan supplier', CreateExpenseSchema, CreateExpenseDto, utan(utgift, 'supplier'), true))
})

describe('leverantörsfaktura — schema och DTO ger samma svar', () => {
  it('giltig kropp godtas av båda', () =>
    paritet(
      'giltig',
      CreateSupplierInvoiceSchema,
      CreateSupplierInvoiceDto,
      leverantorsfaktura,
      true,
    ))

  it('DEN AVGÖRANDE: utan supplierName avvisas av båda', () =>
    paritet(
      'utan supplierName',
      CreateSupplierInvoiceSchema,
      CreateSupplierInvoiceDto,
      utan(leverantorsfaktura, 'supplierName'),
      false,
    ))

  it('UTAN vatAmount godtas av båda — servern räknar själv', () =>
    // Exakt den form som i #795 blev ett 400: webben skickade den, DTO:n
    // krävde fältet. Nu är det ETT prov som skulle ha fällt det.
    paritet(
      'utan vatAmount',
      CreateSupplierInvoiceSchema,
      CreateSupplierInvoiceDto,
      utan(leverantorsfaktura, 'vatAmount'),
      true,
    ))

  it('för kort leverantörsnamn avvisas av båda', () =>
    paritet(
      'namn "A"',
      CreateSupplierInvoiceSchema,
      CreateSupplierInvoiceDto,
      { ...leverantorsfaktura, supplierName: 'A' },
      false,
    ))

  it('KANARIEFÅGEL: ett okänt fält avvisas av pipen', async () => {
    // Utan den kan proven ovan vara gröna av att pipen inte gör något alls.
    expect(await pipenGodtar(CreateSupplierInvoiceDto, { ...leverantorsfaktura, hittepa: 1 })).toBe(
      false,
    )
  })
})

/**
 * UPPRÄKNINGEN — varje delat schema som har en DTO, inte bara de tre någon skrev
 * ett prov för.
 *
 * De namngivna proven ovan mäter GRÄNSER i detalj för bokföringen. Loopen nedan
 * mäter att paritet över huvud taget håller för ALLA poster i registret, så att
 * en sjätte koppling inte kan glida isär tyst. Att registret är FULLSTÄNDIGT
 * ägs av `check-request-contract.mjs`, som kräver att varje delad nyttolasttyp i
 * webben står här — det kan ett prov inte se, och det står därför i vaktens fil.
 */
describe('KONTRAKTSREGISTER — paritet för varje delat schema med en DTO', () => {
  it('registret är icke-trivialt', () => {
    // En loop över en tom lista är grön om ingenting. Talet är en undre gräns,
    // inte en sanning: växer registret ska den här inte behöva ändras.
    expect(KONTRAKTSREGISTER.length).toBeGreaterThanOrEqual(8)
  })

  it.each(KONTRAKTSREGISTER.map((p) => [p.endpoint, p] as const))(
    '%s — giltig kropp godtas av BÅDA',
    async (_endpoint, post) => {
      const zod = schematGodtar(post.schema, post.giltig)
      const dto = await pipenGodtar(post.dto, post.giltig)
      expect({ zod, dto }).toEqual({ zod: true, dto: true })
    },
  )

  it.each(KONTRAKTSREGISTER.map((p) => [p.endpoint, p] as const))(
    '%s — ogiltig kropp avvisas av BÅDA',
    async (_endpoint, post) => {
      const zod = schematGodtar(post.schema, post.ogiltig)
      const dto = await pipenGodtar(post.dto, post.ogiltig)
      expect({ fall: post.ogiltigVarfor, zod, dto }).toEqual({
        fall: post.ogiltigVarfor,
        zod: false,
        dto: false,
      })
    },
  )

  it.each(KONTRAKTSREGISTER.map((p) => [p.endpoint, p] as const))(
    '%s — KANARIEFÅGEL: ett okänt fält avvisas av pipen',
    async (_endpoint, post) => {
      // Utan den kan "giltig godtas" vara grön av att pipen inte gör något alls.
      expect(await pipenGodtar(post.dto, { ...post.giltig, zzHittepa: 1 })).toBe(false)
    },
  )
})

/**
 * KÄND AVVIKELSE — dokumenterad, inte gömd.
 *
 * `z.string().uuid()` och `@IsUUID()` är oense om EXAKT en form: ett id med
 * felaktig variant-nibble. Uppmätt över fem former; de fyra andra (kanonisk v4,
 * v3, nil-uuid, rent skräp) behandlas lika av båda.
 *
 * Praktisk betydelse: liten — riktiga id:n kommer ur databasen och är
 * kanoniska. Men avvikelsen finns, och den yttrar sig som ett 400 på en kropp
 * formuläret sa var giltig. Provet står här så att nästa person hittar den som
 * ett MÄTT förhållande i stället för att upptäcka den igen som en bugg — och så
 * att det blir rött den dag något av biblioteken ändrar sig.
 */
describe('känd avvikelse: uuid-strikthet', () => {
  const felaktigVariant = '11111111-2222-3333-4444-555555555555'

  it('zod godtar den, DTO:n avvisar den', async () => {
    const kropp = {
      unitId: felaktigVariant,
      type: 'ELECTRICITY',
      unitOfMeasure: 'kWh',
    }
    expect(schematGodtar(CreateMeterSchema, kropp)).toBe(true)
    expect(await pipenGodtar(CreateMeterDto, kropp)).toBe(false)
  })

  it('en KANONISK v4 godtas av båda', async () => {
    const kropp = {
      unitId: '11111111-2222-4333-8444-555555555555',
      type: 'ELECTRICITY',
      unitOfMeasure: 'kWh',
    }
    expect(schematGodtar(CreateMeterSchema, kropp)).toBe(true)
    expect(await pipenGodtar(CreateMeterDto, kropp)).toBe(true)
  })
})

/**
 * DATUMFORMATEN — de två beskrivningarna måste godta SAMMA former.
 *
 * `@IsDateString()` accepterar både `2026-09-01` och en full tidsstämpel med
 * offset. Ett `z.string().datetime()` hade avvisat den första, alltså stoppat
 * något servern gärna tar emot; ett blankt `z.string()` hade inte validerat
 * något alls. Uppräkningen nedan är de former som faktiskt förekommer, och den
 * fäller åt båda hållen.
 */
describe('paidAt — datumformat i paritet', () => {
  const bas = { amount: 1250, paymentMethod: 'Bankgiro' }
  const godtagna = [
    '2026-09-01',
    '2026-09-01T10:30:00Z',
    '2026-09-01T10:30:00.000Z',
    '2026-09-01T10:30:00+02:00',
  ]

  it.each(godtagna)('%s godtas av BÅDA', async (paidAt) => {
    const kropp = { ...bas, paidAt }
    const zod = schematGodtar(RegisterPaymentSchema, kropp)
    const dto = await pipenGodtar(RegisterPaymentDto, kropp)
    expect({ paidAt, zod, dto }).toEqual({ paidAt, zod: true, dto: true })
  })

  it.each(['i går', '2026-13-45', ''])('%s avvisas av BÅDA', async (paidAt) => {
    const kropp = { ...bas, paidAt }
    const zod = schematGodtar(RegisterPaymentSchema, kropp)
    const dto = await pipenGodtar(RegisterPaymentDto, kropp)
    expect({ paidAt, zod, dto }).toEqual({ paidAt, zod: false, dto: false })
  })
})

/**
 * KÄND AVVIKELSE 2 — dokumenterad, inte gömd: `.date()` mot `@IsISO8601()`.
 *
 * Registrets DTO:er har TOLV datumfält med `@IsISO8601()`/`@IsDateString()`.
 * ELVA av dem är parade med `z.string().date()` i schemat, som bara godtar
 * ÅÅÅÅ-MM-DD. Dekoratorn godtar dessutom en full tidsstämpel. Schemat är alltså
 * STRÄNGARE än servern på elva fält:
 *
 *   create-journal-entry.date · create-expense.date
 *   supplier-invoice.invoiceDate · .dueDate · .paidDate
 *   create-meter.installedAt · update-meter.removedAt
 *   record-reading.readingDate · .periodStart · .periodEnd
 *   create-tariff.validFrom
 *
 * (Det tolfte, `register-payment.paidAt`, använder `IsoDatumSchema` och är i
 * paritet — se provet ovan.)
 *
 * PRAKTISK BETYDELSE: noll i dag. Fälten fylls av `<input type="date">`, som
 * inte kan producera en tidsstämpel. Riktningen är dessutom den ofarliga —
 * webben stoppar något servern hade tagit emot, inte tvärtom.
 *
 * INTE LAGAD HÄR, och skälet är att båda vägarna har en avvägning:
 * att lossa schemat bryter `dueDate < invoiceDate`, som jämför strängar
 * lexikalt och slutar gälla om den ena bär tid; att strama åt DTO:n avvisar
 * kroppar API:t godtar i dag. Det är ett eget beslut, inte en följdändring i en
 * PR om fakturor.
 *
 * Provet står här så att avvikelsen är MÄTT och blir röd den dag någon ändrar
 * någondera sidan utan att ändra den andra.
 */
describe('känd avvikelse: .date() är strängare än @IsISO8601()', () => {
  const tidsstampel = '2026-09-01T10:30:00Z'

  it('schemat avvisar en tidsstämpel som DTO:n godtar', async () => {
    const kropp = {
      date: tidsstampel,
      description: 'Reparation trapphus',
      amount: 1250,
      accountNumber: 5070,
    }
    expect(schematGodtar(CreateExpenseSchema, kropp)).toBe(false)
    expect(await pipenGodtar(CreateExpenseDto, kropp)).toBe(true)
  })

  it('ett datum utan tid godtas av båda — avvikelsen gäller bara tidsstämpeln', () => {
    const kropp = {
      date: '2026-09-01',
      description: 'Reparation trapphus',
      amount: 1250,
      accountNumber: 5070,
    }
    expect(schematGodtar(CreateExpenseSchema, kropp)).toBe(true)
  })
})
