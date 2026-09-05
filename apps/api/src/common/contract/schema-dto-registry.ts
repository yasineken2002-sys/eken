import {
  CreateExpenseSchema,
  CreateJournalEntrySchema,
  CreateMeterSchema,
  CreatePropertySchema,
  CreateReadingSchema,
  CreateSupplierInvoiceSchema,
  CreateTariffSchema,
  CreateCreditNoteSchema,
  RegisterPaymentSchema,
  UpdateMeterSchema,
} from '@eken/shared'
import { CreateJournalEntryDto } from '../../accounting/dto/create-journal-entry.dto'
import { CreateExpenseDto } from '../../accounting/dto/create-expense.dto'
import { CreateSupplierInvoiceDto } from '../../accounting/dto/supplier-invoice.dto'
import { CreatePropertyDto } from '../../properties/dto/create-property.dto'
import { CreateMeterDto } from '../../consumption/dto/create-meter.dto'
import { UpdateMeterDto } from '../../consumption/dto/update-meter.dto'
import { RecordReadingDto } from '../../consumption/dto/record-reading.dto'
import { CreateTariffDto } from '../../consumption/dto/create-tariff.dto'
import { CreateCreditNoteDto } from '../../invoices/dto/create-credit-note.dto'
import { RegisterPaymentDto } from '../../invoices/dto/register-payment.dto'
import type { ZodType } from 'zod'

/**
 * VARJE DELAT SCHEMA SOM HAR EN DTO — uppräkningen, på ett ställe.
 *
 * ── VARFÖR EN REGISTRERING OCH INTE ETT PROV PER ENDPOINT ───────────────────
 *
 * Ett prov per endpoint täcker de endpoints någon kom ihåg att skriva ett prov
 * för. Den sjätte kopplingen glider då isär tyst, vilket är exakt formen på det
 * fel hela kontraktsarbetet finns för att hindra.
 *
 * Listan här är därför ENDA uppräkningen, och `check-request-contract.mjs`
 * kräver att den är FULLSTÄNDIG: varje nyttolasttyp webben skickar ur
 * @eken/shared måste stå här. Ett tillägg som glöms bort blir rött i CI, inte
 * tyst.
 *
 * ── VAD VARJE POST BÄR ──────────────────────────────────────────────────────
 *
 * `giltig` och `ogiltig` är inte pynt: paritetsprovet kör dem genom BÅDA
 * beskrivningarna (Zod-schemat och DTO:n via riktig ValidationPipe) och kräver
 * samma svar. Utan ett `ogiltig`-fall kunde en DTO som godtar allt vara grön.
 *
 * `ogiltigVarfor` säger vad fallet BRYTER mot — annars går det inte att se om
 * provet mäter regeln man tror.
 */
export interface KontraktsPost {
  /** Endpointen som tar emot kroppen. Står i felmeddelanden. */
  endpoint: string
  /** Namnet på `z.infer`-typen, som vakten matchar mot webbens importer. */
  inputTyp: string
  schema: ZodType<unknown>
  dto: unknown
  giltig: Record<string, unknown>
  ogiltig: Record<string, unknown>
  ogiltigVarfor: string
}

const adress = { street: 'Storgatan 1', city: 'Stockholm', postalCode: '11122', country: 'SE' }

export const KONTRAKTSREGISTER: readonly KontraktsPost[] = [
  {
    endpoint: 'POST /accounting/journal-entries',
    inputTyp: 'CreateJournalEntryInput',
    schema: CreateJournalEntrySchema,
    dto: CreateJournalEntryDto,
    giltig: {
      date: '2026-09-01',
      description: 'Omföring mellan konton',
      lines: [
        { accountNumber: 1930, debit: 100 },
        { accountNumber: 1510, credit: 100 },
      ],
    },
    ogiltig: {
      date: '2026-09-01',
      description: 'Enbent verifikat',
      lines: [{ accountNumber: 1930, debit: 100 }],
    },
    ogiltigVarfor: 'ett verifikat behöver minst två rader',
  },
  {
    endpoint: 'POST /accounting/expenses',
    inputTyp: 'CreateExpenseInput',
    schema: CreateExpenseSchema,
    dto: CreateExpenseDto,
    giltig: {
      date: '2026-09-01',
      description: 'Reparation trapphus',
      amount: 1250,
      accountNumber: 5070,
    },
    ogiltig: {
      date: '2026-09-01',
      description: 'Reparation trapphus',
      amount: 0,
      accountNumber: 5070,
    },
    ogiltigVarfor: 'beloppet måste vara större än noll',
  },
  {
    endpoint: 'POST /accounting/supplier-invoices',
    inputTyp: 'CreateSupplierInvoiceInput',
    schema: CreateSupplierInvoiceSchema,
    dto: CreateSupplierInvoiceDto,
    giltig: {
      supplierName: 'Rörjouren AB',
      description: 'Stambyte trapphus B',
      invoiceDate: '2026-09-01',
      dueDate: '2026-10-01',
      expenseAccount: 5070,
      amount: 1250,
      vatRate: 25,
    },
    ogiltig: {
      description: 'Stambyte trapphus B',
      invoiceDate: '2026-09-01',
      dueDate: '2026-10-01',
      expenseAccount: 5070,
      amount: 1250,
      vatRate: 25,
    },
    ogiltigVarfor: 'supplierName saknas — exakt formen som gav 400 i #795',
  },
  {
    endpoint: 'POST /properties',
    inputTyp: 'CreatePropertyInput',
    schema: CreatePropertySchema,
    dto: CreatePropertyDto,
    giltig: {
      name: 'Kvarteret Eken 1',
      propertyDesignation: 'EKEN 1:1',
      type: 'RESIDENTIAL',
      address: adress,
      totalArea: 850,
    },
    ogiltig: {
      name: 'Kvarteret Eken 1',
      propertyDesignation: 'EKEN 1:1',
      type: 'HYRESHUS',
      address: adress,
      totalArea: 850,
    },
    ogiltigVarfor: 'HYRESHUS är ingen giltig fastighetstyp',
  },
  {
    endpoint: 'POST /consumption/meters',
    inputTyp: 'CreateMeterInput',
    schema: CreateMeterSchema,
    dto: CreateMeterDto,
    giltig: {
      unitId: '11111111-2222-4333-8444-555555555555',
      type: 'ELECTRICITY',
      unitOfMeasure: 'kWh',
    },
    ogiltig: { unitId: 'inte-ett-uuid', type: 'ELECTRICITY', unitOfMeasure: 'kWh' },
    ogiltigVarfor: 'unitId måste vara ett UUID',
  },
  {
    endpoint: 'PATCH /consumption/meters/:id',
    inputTyp: 'UpdateMeterInput',
    schema: UpdateMeterSchema,
    dto: UpdateMeterDto,
    giltig: { status: 'ACTIVE', serialNumber: 'ABC-1' },
    ogiltig: { status: 'TRASIG' },
    ogiltigVarfor: 'TRASIG är ingen giltig mätarstatus',
  },
  {
    endpoint: 'POST /consumption/readings',
    inputTyp: 'CreateReadingInput',
    schema: CreateReadingSchema,
    dto: RecordReadingDto,
    giltig: {
      meterId: '11111111-2222-4333-8444-555555555555',
      value: 1234.5,
      source: 'MANUAL',
      readingDate: '2026-09-01',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
    },
    ogiltig: {
      meterId: '11111111-2222-4333-8444-555555555555',
      value: 1234.5,
      source: 'HANDPÅLÄGGNING',
      readingDate: '2026-09-01',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
    },
    ogiltigVarfor: 'okänd avläsningskälla',
  },
  {
    endpoint: 'POST /consumption/tariffs',
    inputTyp: 'CreateTariffInput',
    schema: CreateTariffSchema,
    dto: CreateTariffDto,
    giltig: {
      scope: 'ORGANIZATION',
      meterType: 'ELECTRICITY',
      pricePerUnit: 2.5,
      validFrom: '2026-01-01',
    },
    ogiltig: {
      scope: 'ORGANIZATION',
      meterType: 'ELECTRICITY',
      pricePerUnit: -1,
      validFrom: '2026-01-01',
    },
    ogiltigVarfor: 'priset kan inte vara negativt',
  },
  {
    endpoint: 'POST /invoices/:id/pay',
    inputTyp: 'RegisterPaymentInput',
    schema: RegisterPaymentSchema,
    dto: RegisterPaymentDto,
    giltig: { amount: 1250, paymentMethod: 'Bankgiro', reference: '1234567' },
    ogiltig: { amount: 0, paymentMethod: 'Bankgiro' },
    ogiltigVarfor: 'ett inbetalt belopp kan inte vara noll',
  },
  {
    endpoint: 'POST /invoices/:id/credit-note',
    inputTyp: 'CreateCreditNoteInput',
    schema: CreateCreditNoteSchema,
    dto: CreateCreditNoteDto,
    giltig: {
      lines: [
        {
          invoiceLineId: '11111111-2222-4333-8444-555555555555',
          quantity: 1,
          unitPrice: 500,
        },
      ],
      reason: 'Felaktigt debiterad avgift',
    },
    ogiltig: {
      lines: [
        {
          invoiceLineId: '11111111-2222-4333-8444-555555555555',
          quantity: 1,
          unitPrice: 500,
        },
      ],
      reason: 'fel',
    },
    ogiltigVarfor:
      'skälet är kortare än fem tecken — en kreditering utan skäl går inte att granska',
  },
]
