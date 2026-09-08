import { IssueKeysDto } from '../keys/dto/issue-keys.dto'
import { ReturnKeyDto } from '../keys/dto/return-key.dto'
import { UpdateKeyDto } from '../keys/dto/update-key.dto'
import { IssueKeysSchema, ReturnKeySchema, UpdateKeySchema } from '@eken/shared'
import {
  ASSIGNABLE_ROLES,
  InviteUserSchema,
  UpdateUserRoleSchema,
  BuyCreditsSchema,
} from '@eken/shared'
import { InviteUserDto } from '../users/dto/invite-user.dto'
import { UpdateUserRoleDto } from '../users/dto/update-user-role.dto'
import { BuyCreditsDto } from '../ai-usage/dto/buy-credits.dto'
import {
  CreateNewsPostSchema,
  UpdateNewsPostSchema,
  SendMessageSchema,
  CreateCustomerSchema,
  UpdateCustomerSchema,
} from '@eken/shared'
import { CreateNewsPostDto } from '../news/dto/create-news-post.dto'
import { UpdateNewsPostDto } from '../news/dto/update-news-post.dto'
import { SendMessageDto } from '../messages/dto/send-message.dto'
import { CreateCustomerDto } from '../customers/dto/create-customer.dto'
import { UpdateCustomerDto } from '../customers/dto/update-customer.dto'
import { CreateMaintenancePlanDto } from '../maintenance-plan/dto/create-maintenance-plan.dto'
import { UpdateMaintenancePlanDto } from '../maintenance-plan/dto/update-maintenance-plan.dto'
import { CreateMiscChargeDto } from '../misc-charges/dto/create-misc-charge.dto'
import { ConfirmBackfillDto } from '../avisering/dto/confirm-backfill.dto'
import { ConfirmContractRowDto } from '../import/dto/confirm-contract-row.dto'
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
  CreateMaintenancePlanSchema,
  UpdateMaintenancePlanSchema,
  CreateMiscChargeSchema,
  ConfirmBackfillSchema,
  ConfirmContractRowSchema,
  CreateExpenseSchema,
  CreateJournalEntrySchema,
  CreateSupplierInvoiceSchema,
} from '@eken/shared'
import { CreateJournalEntryDto } from './dto/create-journal-entry.dto'
import { CreateExpenseDto } from './dto/create-expense.dto'
import { CreateSupplierInvoiceDto } from './dto/supplier-invoice.dto'
import { CreateMeterSchema, RegisterPaymentSchema } from '@eken/shared'
import { RegisterPaymentDto } from '../invoices/dto/register-payment.dto'
import { MarkNoticePaidSchema } from '@eken/shared'
import { MarkPaidDto } from '../avisering/dto/mark-paid.dto'
import { CreateMeterDto } from '../consumption/dto/create-meter.dto'
import { KONTRAKTSREGISTER } from '../common/contract/schema-dto-registry'
import { VALIDATION_PIPE_OPTIONS } from '../common/contract/validation-pipe-options'
import type { ZodType } from 'zod'
import { ReverseEntrySchema, ReopenPeriodSchema, PaySupplierInvoiceSchema } from '@eken/shared'
import { ReverseEntryDto } from './dto/reverse-entry.dto'
import { ReopenPeriodDto } from './dto/reopen-period.dto'
import { PaySupplierInvoiceDto } from './dto/supplier-invoice.dto'

/**
 * PRODUKTIONENS pipe, inte en egen. Raden ovan skrev tidigare fyra av `main.ts`
 * fem inställningar och utelämnade `transformOptions` — provet mätte alltså en
 * konfiguration som inte finns någonstans, och var grönt om en koercion som
 * släpper igenom i skarp drift. Se `common/contract/validation-pipe-options.ts`.
 */
const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS)

async function pipenGodtar(metatype: unknown, kropp: unknown): Promise<boolean> {
  try {
    await pipe.transform(kropp, { type: 'body', metatype: metatype as never })
    return true
  } catch {
    return false
  }
}

const schematGodtar = (schema: ZodType<unknown>, kropp: unknown) => schema.safeParse(kropp).success

describe('accounting — återstående begäranskontrakt', () => {
  describe.each([
    ['rättelse', ReverseEntrySchema, ReverseEntryDto, 300, {}],
    ['återöppning', ReopenPeriodSchema, ReopenPeriodDto, 500, { reasonCategory: 'MISSING_ENTRY' }],
  ] as const)('%s', (_namn, schema, dto, max, extra) => {
    it.each([
      ['saknas', undefined, false],
      ['null', null, false],
      ['tomt', '', false],
      ['blanksteg', ' '.repeat(20), false],
      ['under minimum', 'x'.repeat(9), false],
      ['minimum', 'x'.repeat(10), true],
      ['maximum', 'x'.repeat(max), true],
      ['över maximum', 'x'.repeat(max + 1), false],
      ['trimmas före längdkontroll', `  ${'x'.repeat(max)}  `, true],
    ] as const)('%s', async (namn, reason, vantat) => {
      await paritet(namn, schema, dto, { ...extra, reason }, vantat)
    })

    it('båda ger samma trimmade kropp', async () => {
      const kropp = { ...extra, reason: '  En felaktig bokföring  ' }
      expect(await pipe.transform(kropp, { type: 'body', metatype: dto })).toEqual(
        schema.parse(kropp),
      )
    })

    it('okända kroppsfält avvisas av båda', () =>
      paritet(
        'okänd nyckel',
        schema,
        dto,
        { ...extra, reason: 'En felaktig bokföring', extra: true },
        false,
      ))

    /**
     * VAR EN DOKUMENTERAD AVVIKELSE, ÄR NU PARITET (#847).
     *
     * Provet krävde tidigare att pipen SLÄPPTE IGENOM ett tal — `1234567890`
     * blev `"1234567890"` av `enableImplicitConversion`, medan schemat avvisade
     * det. Avvikelsen var mätt och ärlig, men den var också ett hål: ett skäl
     * som klienten skickade som tal lagrades som text utan att någon sa ifrån.
     *
     * `@StrictString()` läser råvärdet, så båda sidor avvisar nu. Provet är
     * skrivet som paritet i stället för som två separata påståenden, så det
     * blir rött om någon av sidorna ändrar sig — inte bara pipen.
     */
    it.each([
      ['tal', 1234567890],
      ['objekt', { a: 1 }],
      ['lista', ['abc']],
      ['boolean', true],
    ] as const)('%s avvisas av BÅDA — skälet ska vara text', (namn, reason) =>
      paritet(namn, schema, dto, { ...extra, reason }, false),
    )
  })

  it.each([
    ['MISSING_ENTRY', true],
    ['EXISTING_ENTRY_INCORRECT', true],
    ['OTHER', false],
    [undefined, false],
    [null, false],
  ] as const)(
    'återöppningens kategori %s — tjänsten äger beslutet om återöppning',
    (reasonCategory, vantat) =>
      paritet(
        'kategori',
        ReopenPeriodSchema,
        ReopenPeriodDto,
        { reason: 'En betalning saknas', reasonCategory },
        vantat,
      ),
  )

  it.each([
    ['2026-09-01', true],
    ['2026-09-01T12:30:00Z', true],
    ['2026-09-01T12:30:00+02:00', true],
    ['', false],
    ['i går', false],
    [null, false],
    [undefined, false],
  ] as const)('betalningsdatum %s', (paidDate, vantat) =>
    paritet('paidDate', PaySupplierInvoiceSchema, PaySupplierInvoiceDto, { paidDate }, vantat),
  )

  it('betalningen avvisar ett id i kroppen — det hör till URL:en', () =>
    paritet(
      'id i kroppen',
      PaySupplierInvoiceSchema,
      PaySupplierInvoiceDto,
      { paidDate: '2026-09-01', id: 'invoice-id' },
      false,
    ))

  /**
   * VAR EN DOKUMENTERAD AVVIKELSE, ÄR NU PARITET (#847).
   *
   * `@IsISO8601()` godtar varje form ISO 8601 tillåter, inte bara en DAG.
   * Uppmätt mot `IsoDatumSchema` gled fem former isär — det är formerna nedan.
   * `'2026'` var den som stod här; de fyra andra hittades först när mängden
   * räknades upp i stället för att beskrivas.
   *
   * `@StrictIsoDatum()` bär samma krav som schemat, så båda avvisar nu. Att de
   * ÖVERENSSTÄMMER, inte bara att de avvisar, ägs av `strict-iso-datum.spec.ts`,
   * som kör alla formerna genom båda sidor.
   */
  it.each([
    ['enbart år', '2026'],
    ['år och månad', '2026-09'],
    ['tidsstämpel utan tidszon', '2026-09-07T12:00:00'],
    ['kompakt form', '20260907'],
    ['veckoform', '2026-W12'],
  ] as const)('%s avvisas av BÅDA — betalningsdatum ska vara en dag', (namn, paidDate) =>
    paritet(namn, PaySupplierInvoiceSchema, PaySupplierInvoiceDto, { paidDate }, false),
  )
})

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

  // ── TYPKOERCION: DEN HALVA PARITETSPROVET INTE KUNDE SE ────────────────────
  //
  // De tre looparna ovan mäter FORM och OKÄNDA NYCKLAR. Ingen av dem kunde se
  // att pipen KONVERTERAR ett värde innan validatorn får det: den globala
  // `ValidationPipe` kör `transform: true` med `enableImplicitConversion: true`,
  // så class-transformer läser TS-typen och kör `Boolean(värdet)` FÖRE
  // `@IsBoolean()`. `Boolean('false')` är `true`.
  //
  // Uppmätt på `POST /tenant-portal/ai/confirm`, vars `confirmed` är ett
  // uttryckligt ja till en AI-föreslagen handling:
  //
  //     confirmed="false"  zod=AVVISADE  dto=SLÄPPTE IGENOM → true
  //
  // Schemat sa nej, DTO:n sa ja, och paritetsprovet var grönt — alltså mätte
  // det bara halva frågan utan att säga det. Fallen nedan HÄRLEDS ur registret
  // (varje boolesk nyckel i `giltig`), så en ny post med ett booleskt fält får
  // kontrollen utan att någon minns att lägga till den.
  //
  // ── AVGRÄNSAT TILL BOOLEANER, OCH SKÄLET ÄR RIKTNINGEN ─────────────────────
  //
  // Koercionen gäller varje skalär typ: `String(42)` blir `'42'`, så ett tal i
  // ett textfält passerar `@IsString()` lika tyst. UPPMÄTT genom att köra samma
  // härledning över strängfälten i stället:
  //
  //     97 strängfält i registret · 33 av dem koercerar tyst
  //
  // De 64 övriga fälls ändå, av `@IsEmail`/`@IsUUID`/`@IsDateString` — alltså
  // av en tillfällighet i vilken validator fältet råkar bära, inte av något som
  // skyddar. Det är en repo-omfattande avvikelse och hör hemma i ett eget
  // ärende, inte i den här.
  //
  // Booleanerna tas ändå NU, därför att bara de har en farlig riktning:
  // `Boolean('false')` är `true`, alltså blir ett NEJ ett JA. `String(42)` ger
  // '42', vilket är fel men inte motsatsen till vad avsändaren menade.
  //
  // ── SONDVÄRDET ÄR "yes", INTE "false" — OCH BYTET ÄR INTE EN UPPMJUKNING ──
  //
  // Med `@StrictBoolean()` (2026-09-07) är `"false"` en AVSIKTLIGT accepterad
  // form på DTO-sidan: den betyder `false`, vilket är vad avsändaren menade.
  // Zods `z.boolean()` avvisar den, så ett prov som kräver att BÅDA avvisar
  // hade fällt den korrekta lagningen.
  //
  // `"yes"` är i stället ett värde ingen av halvorna får godta — det är inte ett
  // booleskt värde i någon tolkning. Provet mäter alltså fortfarande exakt det
  // det finns för: att pipen inte GISSAR åt en klient. Att `"false"` blir
  // `false` och inte `true` bevisas av `strict-boolean.spec.ts`, mot samma pipe.
  const KOERCIONSFALL = KONTRAKTSREGISTER.flatMap((post) =>
    Object.entries(post.giltig)
      .filter(([, v]) => typeof v === 'boolean')
      .map(([falt]) => [`${post.endpoint} · ${falt}`, post, falt, 'yes'] as const),
  )

  it('KANARIEFÅGEL: provets pipe ÄR produktionens, koercionen inkluderad', () => {
    // Utan den kan raden `transformOptions` tappas igen och varje prov nedan
    // bli grönt av att pipen inte längre konverterar något. Det var precis så
    // den här halvan av paritetsprovet var blind från början.
    expect(VALIDATION_PIPE_OPTIONS.transformOptions?.enableImplicitConversion).toBe(true)
    expect(VALIDATION_PIPE_OPTIONS.forbidNonWhitelisted).toBe(true)
  })

  it('KANARIEFÅGEL: härledningen hittade faktiskt fält att pröva', () => {
    // En tom lista gör varje `it.each` nedan till noll prov — grönt av
    // ingenting. Talet är en undre gräns, inte en sanning.
    expect(KOERCIONSFALL.length).toBeGreaterThanOrEqual(6)
  })

  it.each(KOERCIONSFALL)(
    '%s — strängen "yes" avvisas av BÅDA (pipen gissar aldrig åt en klient)',
    async (_namn, post, falt, felVarde) => {
      const kropp = { ...post.giltig, [falt]: felVarde }
      const zod = schematGodtar(post.schema, kropp)
      const dto = await pipenGodtar(post.dto, kropp)
      expect({ falt, zod, dto }).toEqual({ falt, zod: false, dto: false })
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
  const bas = { amount: 1250, paymentMethod: 'BANK' }
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

/**
 * G3 STÄNGD — samma indata, samma utfall på BÅDA pengavägarna.
 *
 * Före den här ändringen tog avin enumvärdet (`'BANK'`) mot
 * `@IsEnum(PaymentMethod)` medan fakturan tog en etikett (`'Bankgiro'`) mot fri
 * text som `toPaymentMethod` mappade tyst. Samma fältnamn, samma handling, två
 * värdemängder: fakturans värde gav 400 hos avin, avins värde blev `MANUAL` hos
 * fakturan.
 *
 * Provet nedan är den skarpa formen av "enade": för varje indata måste båda
 * vägarna svara LIKA. Ett prov som bara kollat att fakturan godtar `'BANK'` hade
 * varit grönt även om avin fortsatt vara strängare — det är därför utfallen
 * jämförs mot varandra och inte mot en förväntan per väg.
 *
 * Mängden är HELA enumen plus de etiketter gränssnittet erbjuder, så en
 * återinförd textmappning på endera sidan blir röd.
 */
describe('G3: betalsättet betyder samma sak på båda pengavägarna', () => {
  const fakturakropp = (paymentMethod: unknown) => ({ amount: 1250, paymentMethod })
  const avikropp = (paymentMethod: unknown) => ({ paidAmount: 1250, paymentMethod })

  const badaVagarna = async (varde: unknown) => {
    const faktura = {
      zod: schematGodtar(RegisterPaymentSchema, fakturakropp(varde)),
      dto: await pipenGodtar(RegisterPaymentDto, fakturakropp(varde)),
    }
    const avi = {
      zod: schematGodtar(MarkNoticePaidSchema, avikropp(varde)),
      dto: await pipenGodtar(MarkPaidDto, avikropp(varde)),
    }
    return { faktura, avi }
  }

  it.each(['BANK', 'CASH', 'SWISH', 'MANUAL'])('%s godtas av BÅDA vägarna', async (varde) => {
    const { faktura, avi } = await badaVagarna(varde)
    expect({ varde, faktura, avi }).toEqual({
      varde,
      faktura: { zod: true, dto: true },
      avi: { zod: true, dto: true },
    })
  })

  it.each(['Bankgiro', 'Plusgiro', 'Autogiro', 'Swish', 'Kontant'])(
    'ETIKETTEN %s avvisas av BÅDA vägarna — den översätts i webben, inte på servern',
    async (etikett) => {
      const { faktura, avi } = await badaVagarna(etikett)
      expect({ etikett, faktura, avi }).toEqual({
        etikett,
        faktura: { zod: false, dto: false },
        avi: { zod: false, dto: false },
      })
    },
  )

  it.each(['Bitcoin', '', 'bank', 42])('skräpvärdet %p avvisas av BÅDA vägarna', async (varde) => {
    // `'bank'` står med av ett skäl: den gamla mappningen lowercase:ade och hade
    // godtagit den. Att den nu avvisas är hela poängen — inget tyst MANUAL.
    const { faktura, avi } = await badaVagarna(varde)
    expect({ varde, faktura, avi }).toEqual({
      varde,
      faktura: { zod: false, dto: false },
      avi: { zod: false, dto: false },
    })
  })

  it('SKILLNADEN SOM ÄR KVAR, och den är avsiktlig: avin KRÄVER fältet', async () => {
    // Fakturan tillåter att det utelämnas och tolkar det som MANUAL. Avin gör
    // det inte. Provet står här så att skillnaden är MÄTT och inte en glömska —
    // och blir rött den dag någon ändrar endera sidan.
    const utan = { faktura: { amount: 1250 }, avi: { paidAmount: 1250 } }
    expect(schematGodtar(RegisterPaymentSchema, utan.faktura)).toBe(true)
    expect(await pipenGodtar(RegisterPaymentDto, utan.faktura)).toBe(true)
    expect(schematGodtar(MarkNoticePaidSchema, utan.avi)).toBe(false)
    expect(await pipenGodtar(MarkPaidDto, utan.avi)).toBe(false)
  })
})

describe('underhållsplan, övrig debitering, backfill och kontraktsrad — DTO-gränser', () => {
  const plan = {
    title: 'Tak',
    propertyId: '00000000-0000-4000-8000-000000000001',
    plannedYear: 2020,
    estimatedCost: 0,
  }
  const charge = {
    leaseId: '00000000-0000-4000-8000-000000000001',
    tenantId: '00000000-0000-4000-8000-000000000002',
    sourceType: 'KEY_LOSS',
    sourceRefId: '',
    description: '',
    incidentDate: '2026-09-08',
    netAmount: 0.01,
  }

  it.each([
    ['title', 'Ta', false],
    ['title', 'Tak', true],
    ['title', 'x'.repeat(6000), true],
    ['propertyId', 'fel', false],
    ['category', 'ROOF', true],
    ['category', 'fel', false],
    ['plannedYear', 2019, false],
    ['plannedYear', 2020, true],
    ['plannedYear', 2060, true],
    ['plannedYear', 2061, false],
    ['plannedYear', 2020.5, false],
    ['estimatedCost', -0.01, false],
    ['estimatedCost', 0, true],
    ['estimatedCost', 0.01, true],
    ['priority', 0, false],
    ['priority', 1, true],
    ['priority', 3, true],
    ['priority', 4, false],
    ['priority', 1.5, false],
    ['interval', -1, true],
    ['interval', 1.5, false],
    ['lastDoneYear', -1, true],
    ['lastDoneYear', 1.5, false],
  ] as const)('skapa underhåll: %s = %s', (falt, value, vantat) =>
    paritet(
      'skapa underhåll',
      CreateMaintenancePlanSchema,
      CreateMaintenancePlanDto,
      { ...plan, [falt]: value },
      vantat,
    ),
  )

  it('uppdatering kan vara tom och tillåter tom titel', async () => {
    await paritet(
      'tom uppdatering',
      UpdateMaintenancePlanSchema,
      UpdateMaintenancePlanDto,
      {},
      true,
    )
    await paritet(
      'tom titel',
      UpdateMaintenancePlanSchema,
      UpdateMaintenancePlanDto,
      { title: '' },
      true,
    )
  })
  it.each([
    ['plannedYear', 2019, false],
    ['plannedYear', 2020, true],
    ['plannedYear', 2060, true],
    ['plannedYear', 2061, false],
    ['plannedYear', 2020.5, false],
    ['estimatedCost', -0.01, false],
    ['estimatedCost', 0, true],
    ['actualCost', -0.01, false],
    ['actualCost', 0, true],
    ['priority', 0, false],
    ['priority', 1, true],
    ['priority', 3, true],
    ['priority', 4, false],
    ['priority', 1.5, false],
    ['interval', -1, true],
    ['interval', 1.5, false],
    ['lastDoneYear', -1, true],
    ['lastDoneYear', 1.5, false],
    ['status', 'COMPLETED', true],
    ['status', 'fel', false],
    ['completedAt', '2026-09-08', true],
    ['completedAt', '2026-09-08T12:00:00Z', true],
    ['completedAt', 'fel', false],
    ['propertyId', '00000000-0000-4000-8000-000000000001', false],
  ] as const)('uppdatera underhåll: %s = %s', (falt, value, vantat) =>
    paritet(
      'uppdatera underhåll',
      UpdateMaintenancePlanSchema,
      UpdateMaintenancePlanDto,
      { [falt]: value },
      vantat,
    ),
  )

  it.each([
    ['sourceRefId', '', true],
    ['sourceRefId', 'x'.repeat(64), true],
    ['sourceRefId', 'x'.repeat(65), false],
    ['description', '', true],
    ['description', 'x'.repeat(500), true],
    ['description', 'x'.repeat(501), false],
    ['netAmount', 0, false],
    ['netAmount', 0.009, false],
    ['netAmount', 0.01, true],
    ['incidentDate', '2026-09-08T12:00:00Z', true],
    ['incidentDate', 'fel', false],
    ['sourceType', 'INSPECTION_ITEM', true],
    ['sourceType', 'fel', false],
    ['leaseId', 'fel', false],
    ['tenantId', 'fel', false],
  ] as const)('övrig debitering: %s = %s', (falt, value, vantat) =>
    paritet(
      'övrig debitering',
      CreateMiscChargeSchema,
      CreateMiscChargeDto,
      { ...charge, [falt]: value },
      vantat,
    ),
  )

  it('avi-radens XOR-fält hör inte till skapande-DTO:n: inga godtas, båda är okända', async () => {
    // Detta prövar whitelist, inte service-lagrets XOR. En XOR-refine här skulle
    // felaktigt avvisa varje giltig skapandekropp, som inte bär något av fälten.
    await paritet('utan avi-radsfält', CreateMiscChargeSchema, CreateMiscChargeDto, charge, true)
    await paritet(
      'okända avi-radsfält',
      CreateMiscChargeSchema,
      CreateMiscChargeDto,
      { ...charge, consumptionChargeId: charge.leaseId, miscChargeId: charge.tenantId },
      false,
    )
  })

  it.each([
    {},
    { allowBeyondWarning: false },
    { vatDeclarationAcknowledged: true },
    { allowBeyondWarning: true, vatDeclarationAcknowledged: false },
  ])('backfill godtar %j', (kropp) =>
    paritet('backfill', ConfirmBackfillSchema, ConfirmBackfillDto, kropp, true),
  )
  it.each(['allowBeyondWarning', 'vatDeclarationAcknowledged'])(
    'backfill avvisar godtycklig sträng i %s',
    (falt) =>
      paritet('backfill', ConfirmBackfillSchema, ConfirmBackfillDto, { [falt]: 'yes' }, false),
  )
  it.each(['true', 'false'])(
    'befintlig koercion: backfill normaliserar %s i pipen',
    async (value) => {
      const kropp = { allowBeyondWarning: value }
      expect(schematGodtar(ConfirmBackfillSchema, kropp)).toBe(false)
      expect(await pipe.transform(kropp, { type: 'body', metatype: ConfirmBackfillDto })).toEqual({
        allowBeyondWarning: value === 'true',
      })
    },
  )

  it.each([
    {},
    { reviewedData: {} },
    { reviewedData: { arbitrary: [1, null, 'text'] } },
    { unitId: '00000000-0000-4000-8000-000000000001' },
  ])('kontraktsrad godtar %j', (kropp) =>
    paritet('kontraktsrad', ConfirmContractRowSchema, ConfirmContractRowDto, kropp, true),
  )
  it.each([{ unitId: 'fel' }, { reviewedData: [] }, { reviewedData: 'text' }])(
    'kontraktsrad avvisar %j',
    (kropp) =>
      paritet('kontraktsrad', ConfirmContractRowSchema, ConfirmContractRowDto, kropp, false),
  )
})

describe('news, messages och customers — befintliga gränser genom produktionspipen', () => {
  describe.each([
    ['skapa nyhet', CreateNewsPostSchema, CreateNewsPostDto, { title: '', content: '' }],
    ['uppdatera nyhet', UpdateNewsPostSchema, UpdateNewsPostDto, {}],
  ] as const)('%s', (_namn, schema, dto, grund) => {
    it.each([false, true])('booleskt targetAll %s godtas', (targetAll) =>
      paritet('targetAll', schema, dto, { ...grund, targetAll }, true),
    )
    it('tom text och utelämnade valfria fält godtas', () =>
      paritet('minimal kropp', schema, dto, grund, true))
    it('news saknar längdtak', () =>
      paritet(
        'långa texter',
        schema,
        dto,
        { title: 'x'.repeat(6000), content: 'x'.repeat(6000) },
        true,
      ))
    it('ogiltigt uuid avvisas', () =>
      paritet('propertyId', schema, dto, { ...grund, propertyId: 'fel' }, false))
    it('null avlägsnar fastighetsriktningen', () =>
      paritet('propertyId null', schema, dto, { ...grund, propertyId: null }, true))
    it.each(['true', 'false'])(
      'befintlig skillnad: StrictBoolean normaliserar %s, Zod kräver boolean',
      async (targetAll) => {
        const kropp = { ...grund, targetAll }
        expect(schematGodtar(schema, kropp)).toBe(false)
        expect(await pipe.transform(kropp, { type: 'body', metatype: dto })).toEqual({
          ...grund,
          targetAll: targetAll === 'true',
        })
      },
    )
  })

  it.each([
    ['subject', 0, false],
    ['subject', 1, true],
    ['subject', 200, true],
    ['subject', 201, false],
    ['content', 0, false],
    ['content', 1, true],
    ['content', 5000, true],
    ['content', 5001, false],
  ] as const)('messages %s längd %s', (falt, langd, vantat) =>
    paritet(
      'meddelandegräns',
      SendMessageSchema,
      SendMessageDto,
      { subject: 'Hej', content: 'Hej', [falt]: 'x'.repeat(langd) },
      vantat,
    ),
  )

  it('messages kräver uuid för angiven tenantId', () =>
    paritet(
      'tenantId',
      SendMessageSchema,
      SendMessageDto,
      { subject: 'Hej', content: 'Hej', tenantId: 'fel' },
      false,
    ))

  describe.each([
    ['skapa kund', CreateCustomerSchema, CreateCustomerDto, { type: 'INDIVIDUAL' }],
    ['uppdatera kund', UpdateCustomerSchema, UpdateCustomerDto, {}],
  ] as const)('%s', (_namn, schema, dto, grund) => {
    it('minimal kropp godtas', () => paritet('minimal kund', schema, dto, grund, true))
    it('valfria textfält saknar längd- och innehållskrav', () =>
      paritet(
        'kundtext',
        schema,
        dto,
        { ...grund, firstName: '', notes: 'x'.repeat(6000), personalNumber: 'syntetisk-testtext' },
        true,
      ))
    it('tom e-post avvisas', () => paritet('email', schema, dto, { ...grund, email: '' }, false))
  })
})

describe('users och kreditköp — kontrakt genom produktionspipen', () => {
  const inbjudan = { email: 'anna@example.se', firstName: 'Anna', lastName: 'Andersson' }

  describe.each([
    ['inbjudan', InviteUserSchema, InviteUserDto, inbjudan],
    ['rollbyte', UpdateUserRoleSchema, UpdateUserRoleDto, {}],
  ] as const)('%s', (_namn, schema, dto, grund) => {
    it.each(ASSIGNABLE_ROLES)('%s godtas av båda', (role) =>
      paritet('tilldelningsbar roll', schema, dto, { ...grund, role }, true),
    )
    it.each(['OWNER', 'owner', 'SUPERADMIN', '', 'ADMIN ', undefined, null])(
      'rollen %s avvisas av båda',
      (role) => paritet('otillåten roll', schema, dto, { ...grund, role }, false),
    )
  })

  it.each([
    ['firstName', 0, false],
    ['firstName', 1, true],
    ['firstName', 100, true],
    ['firstName', 101, false],
    ['lastName', 0, false],
    ['lastName', 1, true],
    ['lastName', 100, true],
    ['lastName', 101, false],
  ] as const)('inbjudan %s längd %s', (falt, langd, vantat) =>
    paritet(
      'namngräns',
      InviteUserSchema,
      InviteUserDto,
      { ...inbjudan, role: ASSIGNABLE_ROLES[0], [falt]: 'x'.repeat(langd) },
      vantat,
    ),
  )

  it.each([
    ['anna@example.se', true],
    ['anna+tag@example.se', true],
    ['anna@xn--vxj-loa0j.se', true],
    ['', false],
    ['inte-en-adress', false],
    ['anna@', false],
  ] as const)('inbjudan email %s', (email, vantat) =>
    paritet(
      'e-postform',
      InviteUserSchema,
      InviteUserDto,
      { ...inbjudan, role: ASSIGNABLE_ROLES[0], email },
      vantat,
    ),
  )

  // #851: samma form som övriga kontrakt, men biblioteken godtar olika adresser.
  // Skillnaden mäts uttryckligen; detta prov väljer ingen ny valideringspolicy.
  it.each(['anna@växjö.se', 'anna@örebro.se', 'användare@example.se'])(
    'befintlig e-postskillnad: pipen godtar %s, Zod avvisar',
    async (email) => {
      const kropp = { ...inbjudan, role: ASSIGNABLE_ROLES[0], email }
      expect(schematGodtar(InviteUserSchema, kropp)).toBe(false)
      expect(await pipenGodtar(InviteUserDto, kropp)).toBe(true)
    },
  )

  it.each([
    [-1, false],
    [0, false],
    [99, false],
    [100, true],
    [100.5, false],
    [101, false],
    [499, false],
    [500, true],
    [501, false],
    [999, false],
    [1000, true],
    [1001, false],
    [undefined, false],
    [null, false],
  ] as const)('kreditpaketet %s', (amount, vantat) =>
    paritet('paketgräns', BuyCreditsSchema, BuyCreditsDto, { amount }, vantat),
  )

  it('kreditköpet godtar inte klientstyrda fakturafält', () =>
    paritet('okänt prisfält', BuyCreditsSchema, BuyCreditsDto, { amount: 100, price: 1 }, false))

  it.each(['100', '500', '1000'])(
    'befintlig skillnad: pipen konverterar amount %s till tal, Zod kräver tal',
    async (amount) => {
      const kropp = { amount }
      expect(schematGodtar(BuyCreditsSchema, kropp)).toBe(false)
      expect(await pipe.transform(kropp, { type: 'body', metatype: BuyCreditsDto })).toEqual({
        amount: Number(amount),
      })
    },
  )
})

describe('keys — samma DTO-gränser före webbens anrop', () => {
  const issue = { leaseId: '00000000-0000-4000-8000-000000000001', type: 'APARTMENT', quantity: 1 }

  it.each([
    [0, false],
    [1, true],
    [1.5, false],
    [50, true],
    [51, false],
  ] as const)('quantity %s: decimaltal stoppas före anropet', (quantity, vantat) =>
    paritet('antal', IssueKeysSchema, IssueKeysDto, { ...issue, quantity }, vantat),
  )
  it('ogiltigt leaseId avvisas', () =>
    paritet('leaseId', IssueKeysSchema, IssueKeysDto, { ...issue, leaseId: 'fel' }, false))

  describe.each([
    ['utlämning', IssueKeysSchema, IssueKeysDto, issue],
    ['uppdatering', UpdateKeySchema, UpdateKeyDto, {}],
  ] as const)('%s', (_namn, schema, dto, grund) => {
    it.each([
      'APARTMENT',
      'ENTRANCE',
      'MAILBOX',
      'LAUNDRY_TAG',
      'GARAGE',
      'STORAGE',
      'FOB_TAG',
      'OTHER',
    ])('nyckeltyp %s', (type) => paritet('typ', schema, dto, { ...grund, type }, true))
    it('okänd nyckeltyp avvisas', () =>
      paritet('typ', schema, dto, { ...grund, type: 'fel' }, false))
    describe.each(['label', 'issuedToName'])('%s', (falt) => {
      // Bara syntetiska tecken: inga verkliga namn i prov eller logg.
      it.each([
        [0, true],
        [120, true],
        [121, false],
      ] as const)('längd %s', (langd, vantat) =>
        paritet('textgräns', schema, dto, { ...grund, [falt]: 'x'.repeat(langd) }, vantat),
      )
    })
  })

  describe.each([
    ['utlämning', IssueKeysSchema, IssueKeysDto, issue],
    ['retur', ReturnKeySchema, ReturnKeyDto, {}],
    ['uppdatering', UpdateKeySchema, UpdateKeyDto, {}],
  ] as const)('%s: notes', (_namn, schema, dto, grund) => {
    it.each([
      [0, true],
      [1000, true],
      [1001, false],
    ] as const)('längd %s', (langd, vantat) =>
      paritet('notes', schema, dto, { ...grund, notes: 'x'.repeat(langd) }, vantat),
    )
    it('valfria fält får utelämnas', () => paritet('minimal kropp', schema, dto, grund, true))
  })

  describe.each([
    ['issuedAt', IssueKeysSchema, IssueKeysDto, issue],
    ['returnedAt', ReturnKeySchema, ReturnKeyDto, {}],
  ] as const)('%s behålls även utan UI-fält', (falt, schema, dto, grund) => {
    it.each([
      ['2026-09-08', true],
      ['2026-09-08T12:00:00Z', true],
      ['2026-09-08T12:00:00+02:00', true],
      ['fel', false],
      ['', false],
    ] as const)('%s', (datum, vantat) =>
      paritet('datum', schema, dto, { ...grund, [falt]: datum }, vantat),
    )
  })

  it.each([
    ['LOST', true],
    ['REPLACED', true],
    ['ISSUED', false],
    ['RETURNED', false],
  ] as const)('uppdateringsstatus %s', (status, vantat) =>
    paritet('status', UpdateKeySchema, UpdateKeyDto, { status }, vantat),
  )
})
