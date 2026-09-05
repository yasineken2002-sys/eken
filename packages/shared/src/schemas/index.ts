import { z } from 'zod'

export * from './contract'
import {
  isValidSwedishPersonalNumber,
  isValidSwedishOrgNumber,
  isValidOcrNumber,
  PASSWORD_MIN_LENGTH,
  PASSWORD_SPECIAL_CHAR_REGEX,
  validateSwedishOrgNumber,
} from '../utils'

// ─── Pagination ───────────────────────────────────────────────────────────────

export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

// ─── Auth ─────────────────────────────────────────────────────────────────────

// Starkt lösenord: minst 10 tecken med stor/liten/siffra/specialtecken.
// Hård policy — håller enterprise-nivå (jfr. Fortnox och svenska banker).
export const StrongPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Lösenordet måste vara minst ${PASSWORD_MIN_LENGTH} tecken`)
  .regex(/[a-z]/, 'Lösenordet måste innehålla en liten bokstav')
  .regex(/[A-Z]/, 'Lösenordet måste innehålla en stor bokstav')
  .regex(/[0-9]/, 'Lösenordet måste innehålla en siffra')
  .regex(PASSWORD_SPECIAL_CHAR_REGEX, 'Lösenordet måste innehålla ett specialtecken')
  .max(128, 'Lösenordet är för långt')

export const LoginSchema = z.object({
  email: z.string().email('Ogiltig e-postadress'),
  password: z.string().min(1, 'Lösenord krävs'),
})

// Företagsformer som matchar Prismas CompanyForm-enum exakt — vi
// dubbel-deklarerar inte enumen i Prisma och Zod, utan håller en
// strängunion som båda sidor refererar till. Backend mappar detta direkt
// till `Prisma.CompanyForm` och frontend renderar dropdown-alternativ
// från COMPANY_FORM_OPTIONS i shared/utils.
export const CompanyFormSchema = z.enum([
  'AB',
  'ENSKILD_FIRMA',
  'HB',
  'KB',
  'FORENING',
  'STIFTELSE',
])

export const RegisterSchema = z
  .object({
    email: z.string().email('Ogiltig e-postadress'),
    password: StrongPasswordSchema,
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100),
    organizationName: z.string().min(1).max(200),
    companyForm: CompanyFormSchema.default('AB'),
    orgNumber: z.string().optional(),
    // F-skatt: frivillig uppgift på faktura, inte lagkrav (#392). Defaultar
    // till false så att nya konton inte felaktigt påstår att de är
    // godkända — användaren bockar i själv när de fått beslutet.
    hasFSkatt: z.boolean().default(false),
    fSkattApprovedDate: z.string().date().optional(),
    vatNumber: z.string().optional(),
    accountType: z.enum(['COMPANY', 'PRIVATE']).default('COMPANY'),
  })
  // Kombinerad orgnummer-validering: orgnumret måste matcha vald form.
  // Tom orgnummer släpps igenom (valfritt fält); skrivet orgnummer
  // måste passera validateSwedishOrgNumber med rätt företagsform.
  .superRefine((data, ctx) => {
    if (!data.orgNumber) return
    const result = validateSwedishOrgNumber(data.orgNumber, data.companyForm)
    if (!result.valid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: result.error ?? 'Ogiltigt organisationsnummer',
        path: ['orgNumber'],
      })
    }
  })
  // F-skatt-datum får inte ligga i framtiden och ska bara anges när
  // hasFSkatt = true (annars är det meningslöst data).
  .superRefine((data, ctx) => {
    if (data.fSkattApprovedDate && !data.hasFSkatt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'F-skatt-datum kan bara anges när "Vi innehar F-skatt" är ikryssad',
        path: ['fSkattApprovedDate'],
      })
    }
    if (data.fSkattApprovedDate) {
      const d = new Date(data.fSkattApprovedDate)
      if (d > new Date()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'F-skatt-datum kan inte ligga i framtiden',
          path: ['fSkattApprovedDate'],
        })
      }
    }
  })

export const RefreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
})

export const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: StrongPasswordSchema,
    confirmPassword: z.string().min(1),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: 'Lösenorden matchar inte',
    path: ['confirmPassword'],
  })
  .refine((d) => d.newPassword !== d.currentPassword, {
    message: 'Det nya lösenordet måste skilja sig från det gamla',
    path: ['newPassword'],
  })

// Schema för lösenordsåterställning + tenant-aktivering.
export const ResetPasswordSchema = z
  .object({
    newPassword: StrongPasswordSchema,
    confirmPassword: z.string().min(1),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: 'Lösenorden matchar inte',
    path: ['confirmPassword'],
  })

// ─── Address ─────────────────────────────────────────────────────────────────

// Svenska postnummer: första tre siffrorna pekar ut PostNord-områden i
// intervallet 100 (Stockholm) till 984 (Pajala). Allt utanför dvs. 0XX
// och 985–999 är ogiltigt. Ett frivilligt mellanslag mellan siffergrupperna
// accepteras (t.ex. "111 22").
const SWEDISH_POSTAL_CODE_REGEX = /^[1-9]\d{2}\s?\d{2}$/
const SWEDISH_POSTAL_AREA_MIN = 100
const SWEDISH_POSTAL_AREA_MAX = 984

function isValidSwedishPostalCode(value: string): boolean {
  if (!SWEDISH_POSTAL_CODE_REGEX.test(value)) return false
  const area = parseInt(value.slice(0, 3), 10)
  return area >= SWEDISH_POSTAL_AREA_MIN && area <= SWEDISH_POSTAL_AREA_MAX
}

export const AddressSchema = z.object({
  street: z.string().min(1),
  city: z.string().min(1),
  postalCode: z.string().refine(isValidSwedishPostalCode, 'Ogiltigt postnummer'),
  country: z.string().default('SE'),
})

// ─── Property ─────────────────────────────────────────────────────────────────

export const PropertyTypeSchema = z.enum([
  'RESIDENTIAL',
  'COMMERCIAL',
  'MIXED',
  'INDUSTRIAL',
  'LAND',
])

export const CreatePropertySchema = z.object({
  name: z.string().min(1).max(200),
  propertyDesignation: z.string().min(1),
  type: PropertyTypeSchema,
  address: AddressSchema,
  totalArea: z.number().positive(),
  yearBuilt: z.number().int().min(1800).max(new Date().getFullYear()).optional(),
})

export const UpdatePropertySchema = CreatePropertySchema.partial()

// ─── Unit ─────────────────────────────────────────────────────────────────────

export const UnitTypeSchema = z.enum([
  'APARTMENT',
  'OFFICE',
  'RETAIL',
  'STORAGE',
  'PARKING',
  'OTHER',
])
export const UnitStatusSchema = z.enum(['VACANT', 'OCCUPIED', 'UNDER_RENOVATION', 'RESERVED'])

export const CreateUnitSchema = z.object({
  name: z.string().min(1).max(200),
  unitNumber: z.string().min(1).max(50),
  type: UnitTypeSchema,
  area: z.number().positive(),
  floor: z.number().int().optional(),
  rooms: z.number().int().positive().optional(),
  monthlyRent: z.number().nonnegative(),
})

export const UpdateUnitSchema = CreateUnitSchema.partial()

// ─── Tenant ───────────────────────────────────────────────────────────────────

export const CreateTenantSchema = z
  .object({
    type: z.enum(['INDIVIDUAL', 'COMPANY']),
    firstName: z.string().min(1).max(100).optional(),
    lastName: z.string().min(1).max(100).optional(),
    personalNumber: z
      .string()
      .optional()
      .refine(
        (v) => !v || isValidSwedishPersonalNumber(v),
        'Ogiltigt personnummer (kontrollera format och kontrollsiffra)',
      ),
    companyName: z.string().min(1).max(200).optional(),
    orgNumber: z
      .string()
      .optional()
      .refine((v) => !v || isValidSwedishOrgNumber(v), 'Ogiltigt organisationsnummer'),
    contactPerson: z.string().max(200).optional(),
    email: z.string().email(),
    phone: z.string().optional(),
    address: AddressSchema.optional(),
  })
  .refine(
    (d) => {
      if (d.type === 'INDIVIDUAL') return d.firstName && d.lastName
      if (d.type === 'COMPANY') return d.companyName
      return false
    },
    { message: 'Namn krävs för valt hyresgästtyp' },
  )

export const UpdateTenantSchema = CreateTenantSchema.innerType().partial()

// ─── Lease ────────────────────────────────────────────────────────────────────

export const CreateLeaseSchema = z
  .object({
    unitId: z.string().uuid(),
    tenantId: z.string().uuid(),
    startDate: z.string().date(),
    endDate: z.string().date().optional(),
    monthlyRent: z.number().positive(),
    depositAmount: z.number().nonnegative(),
    noticePeriodMonths: z.number().int().min(1).max(12).default(3),
    indexClause: z.boolean().default(false),
  })
  .refine(
    (d) => {
      if (d.endDate) return new Date(d.endDate) > new Date(d.startDate)
      return true
    },
    { message: 'Slutdatum måste vara efter startdatum', path: ['endDate'] },
  )

export const UpdateLeaseSchema = CreateLeaseSchema.innerType().partial()

// Schema för det kombinerade flödet där en hyresgäst skapas tillsammans med
// kontraktet (POST /leases/with-tenant). Adress + pers/orgnummer är optionella
// — fältkraven valideras backend för att stödja både privatperson och företag.
export const NewTenantInLeaseSchema = z.object({
  type: z.enum(['INDIVIDUAL', 'COMPANY']),
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  companyName: z.string().min(1).max(200).optional(),
  email: z.string().email(),
  phone: z.string().optional(),
  personalNumber: z.string().optional(),
  orgNumber: z.string().optional(),
  street: z.string().optional(),
  city: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
})

export const CreateLeaseWithTenantSchema = z
  .object({
    unitId: z.string().uuid(),
    existingTenantId: z.string().uuid().optional(),
    newTenant: NewTenantInLeaseSchema.optional(),
    monthlyRent: z.number().positive(),
    depositAmount: z.number().nonnegative().optional(),
    startDate: z.string().date(),
    endDate: z.string().date().optional(),
    leaseType: z.enum(['FIXED_TERM', 'INDEFINITE']).optional(),
    renewalPeriodMonths: z.number().int().min(1).optional(),
    // JB 12 kap 4 § — minst 3 mån (bostad) eller 9 mån (lokal). API-laget
    // gör den bostad-/lokal-specifika kontrollen mot Unit.type; här
    // garanterar vi bara att värdet är ett positivt heltal.
    noticePeriodMonths: z.number().int().min(1).max(60).optional(),
  })
  .refine((d) => Boolean(d.existingTenantId) !== Boolean(d.newTenant), {
    message: 'Ange antingen en befintlig hyresgäst eller uppgifter för en ny',
    path: ['existingTenantId'],
  })

// ─── OCR (Bankgiro Luhn-mod10) ───────────────────────────────────────────────

// OCR-numret ska vara 2–25 siffror (Bankgirot tillåter teoretiskt 2 siffror,
// i praktiken minst 4) med Luhn-modulus10 kontrollsiffra som sista tecken.
// Validering återanvänder isValidOcrNumber från utils så vi inte håller två
// implementationer av Luhn-checken.
export const OcrSchema = z
  .string()
  .min(2, 'OCR-nummer måste vara minst 2 siffror')
  .max(25, 'OCR-nummer får inte vara längre än 25 siffror')
  .regex(/^\d+$/, 'OCR-nummer får bara innehålla siffror')
  .refine(isValidOcrNumber, 'Ogiltig OCR-kontrollsiffra')

// ─── Invoice ──────────────────────────────────────────────────────────────────

export const InvoiceLineSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().positive(),
  unitPrice: z.number(),
  vatRate: z.union([z.literal(0), z.literal(6), z.literal(12), z.literal(25)]),
})

// En faktura måste ha exakt en av leaseId (hyresgäst-faktura) eller customerId
// (extern kund-faktura) — aldrig båda, aldrig ingen.
export const CreateInvoiceSchema = z
  .object({
    type: z.enum(['RENT', 'DEPOSIT', 'SERVICE', 'UTILITY', 'OTHER']),
    leaseId: z.string().uuid().optional(),
    customerId: z.string().uuid().optional(),
    lines: z.array(InvoiceLineSchema).min(1),
    dueDate: z.string().date(),
    issueDate: z.string().date(),
    reference: z.string().optional(),
    notes: z.string().max(1000).optional(),
  })
  .refine((d) => (d.leaseId != null) !== (d.customerId != null), {
    message: 'Faktura måste vara kopplad till antingen hyresavtal eller extern kund',
    path: ['leaseId'],
  })

// ─── Type exports ─────────────────────────────────────────────────────────────

export type LoginInput = z.infer<typeof LoginSchema>
export type RegisterInput = z.infer<typeof RegisterSchema>
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>
export type CreatePropertyInput = z.infer<typeof CreatePropertySchema>
export type UpdatePropertyInput = z.infer<typeof UpdatePropertySchema>
export type CreateUnitInput = z.infer<typeof CreateUnitSchema>
export type CreateTenantInput = z.infer<typeof CreateTenantSchema>
export type CreateLeaseInput = z.infer<typeof CreateLeaseSchema>
export type CreateLeaseWithTenantInput = z.infer<typeof CreateLeaseWithTenantSchema>
export type NewTenantInLeaseInput = z.infer<typeof NewTenantInLeaseSchema>
export type CreateInvoiceInput = z.infer<typeof CreateInvoiceSchema>
export type OcrInput = z.infer<typeof OcrSchema>

// ─── Förbrukning / IMD — Mätare ───────────────────────────────────────────────
// Speglar CreateMeterDto/UpdateMeterDto i apps/api. Frontend-formulär validerar
// mot dessa scheman (samma regler som backend) innan POST/PATCH.

export const MeterTypeEnum = z.enum(['ELECTRICITY', 'WATER_COLD', 'WATER_HOT', 'HEATING'])
export const MeterStatusEnum = z.enum(['ACTIVE', 'INACTIVE', 'REMOVED'])

export const CreateMeterSchema = z.object({
  unitId: z.string().uuid({ message: 'Välj en enhet för mätaren' }),
  type: MeterTypeEnum,
  unitOfMeasure: z.string().min(1, 'Ange mätenhet (t.ex. kWh, m³)').max(16),
  serialNumber: z.string().max(64).optional(),
  provider: z.string().max(64).optional(),
  externalId: z.string().max(128).optional(),
  installedAt: z.string().date().optional(),
})

export const UpdateMeterSchema = z.object({
  status: MeterStatusEnum.optional(),
  serialNumber: z.string().max(64).optional(),
  provider: z.string().max(64).optional(),
  externalId: z.string().max(128).optional(),
  removedAt: z.string().date().optional(),
})

export type CreateMeterInput = z.infer<typeof CreateMeterSchema>
export type UpdateMeterInput = z.infer<typeof UpdateMeterSchema>

// ─── Förbrukning / IMD — Tariffer ─────────────────────────────────────────────
// Speglar CreateTariffDto i apps/api. validTo sätts automatiskt av servicen
// (stänger föregående tariff) och ingår därför inte i create-schemat.

export const TariffScopeEnum = z.enum(['ORGANIZATION', 'PROPERTY', 'UNIT'])

export const CreateTariffSchema = z
  .object({
    scope: TariffScopeEnum,
    propertyId: z.string().uuid().optional(),
    unitId: z.string().uuid().optional(),
    meterType: MeterTypeEnum,
    pricePerUnit: z.number().min(0, 'Priset kan inte vara negativt'),
    fixedMonthlyFee: z.number().min(0, 'Avgiften kan inte vara negativ').optional(),
    validFrom: z.string().date(),
    // Beräkningsgrund (JB 12:19): valfri fri dokumentationstext. Speglar
    // backendens @MaxLength(2000); ingår aldrig i någon debiteringskalkyl.
    calculationBasis: z.string().max(2000, 'Högst 2000 tecken').optional(),
  })
  // Scope-målet måste anges för PROPERTY/UNIT (samma regel som backend-servicen).
  .refine((d) => d.scope !== 'PROPERTY' || !!d.propertyId, {
    message: 'Välj en fastighet för fastighetstariffen',
    path: ['propertyId'],
  })
  .refine((d) => d.scope !== 'UNIT' || !!d.unitId, {
    message: 'Välj en enhet för enhetstariffen',
    path: ['unitId'],
  })

export type CreateTariffInput = z.infer<typeof CreateTariffSchema>

// ─── Förbrukning / IMD — Avläsningar ──────────────────────────────────────────
// Speglar RecordReadingDto i apps/api. Den hårda spärren (CUMULATIVE lägre än
// föregående → 400) ligger i backend (computeQuantity) och replikeras ALDRIG som
// blockering i klienten — frontenden visar bara en mjuk rimlighetsvarning.

export const ReadingTypeEnum = z.enum(['CUMULATIVE', 'PERIOD_VOLUME'])
export const ReadingSourceEnum = z.enum(['MANUAL', 'IMPORT', 'API'])

export const CreateReadingSchema = z
  .object({
    meterId: z.string().uuid({ message: 'Välj en mätare' }),
    value: z.number().min(0, 'Värdet kan inte vara negativt'),
    readingType: ReadingTypeEnum.optional(),
    source: ReadingSourceEnum,
    readingDate: z.string().date(),
    periodStart: z.string().date(),
    periodEnd: z.string().date(),
    externalId: z.string().max(128).optional(),
    leaseId: z.string().uuid().optional(),
    notes: z.string().max(1000).optional(),
  })
  // Mätperiodens slut får inte vara före start (samma regel som backend).
  .refine((d) => d.periodEnd >= d.periodStart, {
    message: 'Periodens slut får inte vara före periodens start',
    path: ['periodEnd'],
  })

export type CreateReadingInput = z.infer<typeof CreateReadingSchema>

// ─── Teknisk förvaltning — övrig debiterbar post (MiscCharge, Spår A) ──────────
// Input-schema för att skapa en debiterbar post (skada/nyckel) mot en hyresgäst.
// Speglar consumption-mönstret: frontend-formulär validerar mot samma regler som
// backend-DTO:n (PR 3 — debiterings-servicen). PR 1 exporterar bara schemat;
// bokföring/service byggs senare. Belopp anges netto (netAmount); moms snapshotas
// i servicen (momsbeslutet dokumenteras i PR 2), därför ingår vat* inte här.

export const MiscChargeSourceEnum = z.enum(['MAINTENANCE_TICKET', 'INSPECTION_ITEM', 'KEY_LOSS'])

export const CreateMiscChargeSchema = z.object({
  leaseId: z.string().uuid({ message: 'Välj ett hyresavtal' }),
  tenantId: z.string().uuid({ message: 'Välj en hyresgäst' }),
  sourceType: MiscChargeSourceEnum,
  sourceRefId: z.string().min(1, 'Källreferens krävs'),
  description: z.string().min(1, 'Ange en beskrivning').max(500, 'Högst 500 tecken'),
  // När skadan/förlusten konstaterades — styr bokföringsdatum (PR 2).
  incidentDate: z.string().date(),
  netAmount: z.number().min(0, 'Beloppet kan inte vara negativt'),
})

export type CreateMiscChargeInput = z.infer<typeof CreateMiscChargeSchema>

// ─── Bokföring: manuella verifikat, utgifter och leverantörsfakturor ──────────
//
// PILOTEN för kontraktsmönstret (se ./contract.ts). De tre schemana nedan är
// ENDA källan till nyttolastens form: webbens formulär validerar mot dem via
// zodResolver, webbens API-anrop skickar `z.infer`-typen, och API:ts DTO
// deklarerar `implements` mot samma typ plus en nyckelparitetsrad. Ett fält som
// bara finns på ena sidan är därmed ett KOMPILERINGSFEL, inte ett 400-svar.
//
// class-validator ligger kvar i DTO:erna och är fortfarande den som validerar i
// runtime. Schemat beskriver FORMEN; dekoratorerna beskriver GRÄNSERNA. Där de
// överlappar (t.ex. maxlängd) är schemat det formuläret visar och dekoratorn det
// servern verkställer — och båda ska säga samma sak.

/** BAS-kontonummer är fyrsiffriga. Samma intervall som DTO:ernas @Min/@Max. */
const BasKontoSchema = z
  .number()
  .int('Kontonummer måste vara ett heltal')
  .min(1000, 'BAS-kontonummer är fyrsiffriga (1000–8999)')
  .max(8999, 'BAS-kontonummer är fyrsiffriga (1000–8999)')

const BeloppSchema = z.number().multipleOf(0.01, 'Beloppet anges med högst två decimaler')

export const JournalLineSchema = z.object({
  accountNumber: BasKontoSchema,
  debit: BeloppSchema.min(0, 'Debet kan inte vara negativt — byt till kredit i stället').optional(),
  credit: BeloppSchema.min(
    0,
    'Kredit kan inte vara negativt — byt till debet i stället',
  ).optional(),
  description: z.string().max(200, 'Radtexten får vara högst 200 tecken').optional(),
})

export const CreateJournalEntrySchema = z.object({
  date: z.string().date('Datum måste anges som ÅÅÅÅ-MM-DD'),
  description: z
    .string()
    .min(3, 'Beskrivningen måste vara minst 3 tecken')
    .max(300, 'Beskrivningen får vara högst 300 tecken'),
  lines: z.array(JournalLineSchema).min(2, 'Ett verifikat behöver minst två konteringsrader'),
  /**
   * En nyckel per öppnad modal. Två skickningar med samma nyckel ger EN
   * journalpost. VALFRI i kontraktet därför att servern faller tillbaka på en
   * egen nyckel när den saknas — en äldre klient ska inte få 400.
   */
  idempotencyKey: z.string().max(100).optional(),
  attachmentUrl: z.string().max(500).optional(),
})

export const CreateExpenseSchema = z.object({
  date: z.string().date('Datum måste anges som ÅÅÅÅ-MM-DD'),
  description: z
    .string()
    .min(3, 'Beskrivningen måste vara minst 3 tecken')
    .max(300, 'Beskrivningen får vara högst 300 tecken'),
  supplier: z.string().max(200, 'Leverantörsnamnet får vara högst 200 tecken').optional(),
  /** BRUTTO — det som lämnar bankkontot. Momsen bryts UT ur det, inte till. */
  amount: BeloppSchema.min(0.01, 'Beloppet måste vara större än noll'),
  vatRate: z.number().optional(),
  vatAmount: BeloppSchema.min(0, 'Momsbeloppet kan inte vara negativt').optional(),
  accountNumber: BasKontoSchema,
  idempotencyKey: z.string().max(100).optional(),
  attachmentUrl: z.string().max(500).optional(),
})

export const CreateSupplierInvoiceSchema = z.object({
  supplierName: z
    .string()
    .min(2, 'Leverantörsnamnet måste vara minst 2 tecken')
    .max(200, 'Leverantörsnamnet får vara högst 200 tecken'),
  /** Leverantörens EGET fakturanummer. Vårt verifikationsnummer är ett annat. */
  invoiceNumber: z.string().max(60, 'Fakturanumret får vara högst 60 tecken').optional(),
  description: z
    .string()
    .min(3, 'Beskrivningen måste vara minst 3 tecken')
    .max(300, 'Beskrivningen får vara högst 300 tecken'),
  invoiceDate: z.string().date('Fakturadatum måste anges som ÅÅÅÅ-MM-DD'),
  dueDate: z.string().date('Förfallodatum måste anges som ÅÅÅÅ-MM-DD'),
  expenseAccount: BasKontoSchema,
  /** BRUTTO — det som står på fakturan. */
  amount: BeloppSchema.min(0.01, 'Beloppet måste vara större än noll'),
  vatRate: z.number(),
  /** Valfritt: servern räknar själv och godtar ett inskickat tal inom ett öre. */
  vatAmount: BeloppSchema.min(0, 'Momsbeloppet kan inte vara negativt').optional(),
  attachmentUrl: z.string().max(500).optional(),
})

export const PaySupplierInvoiceSchema = z.object({
  paidDate: z.string().date('Betalningsdatum måste anges som ÅÅÅÅ-MM-DD'),
})

export type JournalLineInput = z.infer<typeof JournalLineSchema>
export type CreateJournalEntryInput = z.infer<typeof CreateJournalEntrySchema>
export type CreateExpenseInput = z.infer<typeof CreateExpenseSchema>
export type CreateSupplierInvoiceInput = z.infer<typeof CreateSupplierInvoiceSchema>
export type PaySupplierInvoiceInput = z.infer<typeof PaySupplierInvoiceSchema>

// ─── Fakturor: betalning och kreditnota ───────────────────────────────────────
//
// Pengaflöde. Ett kontraktsglapp här är i bästa fall ett 400 och i sämsta fall
// ett belopp som bokförs på fel sätt — därför delade scheman, samma mönster som
// bokföringen (se ./contract.ts).

export const RegisterPaymentSchema = z.object({
  /** Inbetalt belopp i kronor. Grindas mot restskulden server-side. */
  amount: z.number().positive('Beloppet måste vara större än noll'),
  /**
   * FRI TEXT med flit, inte en enum.
   *
   * Servern normaliserar via `toPaymentMethod` till Prisma-enumen
   * (BANK/CASH/SWISH/MANUAL), och den mängden är GROVARE än de fem alternativ
   * gränssnittet erbjuder: Bankgiro, Plusgiro och Autogiro blir alla `BANK`.
   * Att skriva de fem här hade alltså PÅSTÅTT en precision modellen inte har.
   * Se glidning G2 i PR-texten.
   */
  paymentMethod: z.string().optional(),
  /** OCR eller annan referens. Utelämnad faller servern tillbaka på OCR-numret. */
  reference: z.string().optional(),
  /** Betalningsdatum (ISO). Utelämnat: nu. */
  paidAt: z.string().optional(),
})

export const CreditNoteLineSchema = z.object({
  invoiceLineId: z.string().uuid('invoiceLineId måste vara ett giltigt UUID'),
  /** Egen radtext. Utelämnad ärvs originalets. */
  description: z.string().optional(),
  quantity: z.number().min(0.01, 'Antal måste vara större än noll'),
  /** Belopp per enhet EXKLUSIVE moms — samma riktning som fakturaraden. */
  unitPrice: z.number().min(0.01, 'Belopp per enhet måste vara större än noll'),
})

export const CreateCreditNoteSchema = z.object({
  lines: z.array(CreditNoteLineSchema).min(1, 'En kreditnota måste innehålla minst en rad'),
  /**
   * Skälet blir kreditnotans anteckning och läggs i händelseloggen. Samma krav
   * som på en verifikaträttelse: en korrigering utan angivet skäl går inte att
   * granska i efterhand.
   */
  reason: z.string().min(5, 'Ange ett skäl till krediteringen (minst 5 tecken)'),
})

export type RegisterPaymentInput = z.infer<typeof RegisterPaymentSchema>
export type CreditNoteLineInput = z.infer<typeof CreditNoteLineSchema>
export type CreateCreditNoteInput = z.infer<typeof CreateCreditNoteSchema>
