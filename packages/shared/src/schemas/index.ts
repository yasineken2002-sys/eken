import { z } from 'zod'
import { ASSIGNABLE_ROLES, BRAND_FONTS, REMINDER_FEE_MAX_SEK } from '../constants'

export * from './contract'
export * from './agent-delegation'
import {
  isValidSwedishPersonalNumber,
  isValidSwedishOrgNumber,
  isValidOcrNumber,
  PASSWORD_MIN_LENGTH,
  PASSWORD_SPECIAL_CHAR_REGEX,
  validateSwedishOrgNumber,
} from '../utils'

/**
 * ETT ISO-DATUM SÅ SOM `@IsDateString()` DEFINIERAR DET — datum eller
 * tidsstämpel med valfri offset. Finns som egen symbol för att nästa fält som
 * ska spegla den dekoratorn inte ska behöva mäta om vilken Zod-form som
 * motsvarar den.
 */
export const IsoDatumSchema = z.union([z.string().date(), z.string().datetime({ offset: true })])

// ^ HISSAD hit 2026-09-06. Symbolen låg tidigare mitt i filen, under
// fakturaavsnittet, och varje nytt schema OVANFÖR den punkten föll på
// "used before its declaration" — tre gånger under kontraktsarbetet. Ett
// datumformat är inte fakturornas egendom; det används av avtal, uppsägningar
// och betalningar lika mycket. Den bor därför överst.

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

/**
 * INLOGGNING VALIDERAR INTE LÖSENORDSSTYRKA — med flit.
 *
 * `password` kräver bara att fältet inte är tomt. Ett längdkrav här hade gett
 * ett VALIDERINGSFEL i stället för ett autentiseringsfel, och det är fel på tre
 * sätt: det avslöjar lösenordspolicyn för den som inte är inloggad, det stänger
 * ute en användare vars äldre lösenord är kortare än dagens krav, och det gör
 * svaret olika beroende på indata — vilket är ett orakel.
 *
 * Styrkekravet hör till REGISTRERING och BYTE, och där är det redan en källa
 * (`StrongPasswordSchema` och `IsStrongPassword` härleds båda ur
 * `PASSWORD_MIN_LENGTH` och `PASSWORD_SPECIAL_CHAR_REGEX`).
 *
 * `LoginDto` bar `@MinLength(8)` fram till 2026-09-07 och var alltså STRÄNGARE
 * än schemat. Det rättades i DTO:n, inte i schemat — se docblocket där.
 */
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

    // ── SAKNADES HELT, OCH DET VAR EN LEVANDE GLIDNING ──────────────────────
    //
    // `RegisterDto` har krävt `acceptTerms` med `@Equals(true)` hela tiden.
    // Schemat — den påstådda enda källan — hade inte fältet alls. Webben
    // fungerade bara därför att `auth.api.ts` bar en EGEN `RegisterInput` med
    // `acceptTerms: true`, alltså var den privata kopian mer korrekt än den
    // delade. Hade någon bundit sig till schemat som det stod hade
    // registreringen slutat fungera.
    //
    // `z.literal(true)` och inte `z.boolean()`: DTO:n säger `@Equals(true)`, och
    // ett schema som godtar `false` hade beskrivit ett anrop servern avvisar.
    // Det är ett SAMTYCKE — "vet ej" och "nej" är samma sak här, och båda ska
    // nekas.
    acceptTerms: z.literal(true),
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

// ─── Autentiseringens NYTTOLASTER (etapp: kontraktsbaslinjen) ────────────────
//
// ── VARFÖR NYA SCHEMAN OCH INTE `ChangePasswordSchema` OVAN ─────────────────
//
// De två som redan finns är FORMULÄRSCHEMAN. De bär `confirmPassword`, som är
// en gränssnittsangelägenhet och aldrig går på tråden, och `ResetPasswordSchema`
// saknar `token`, som är själva behörigheten i anropet.
//
// Att låna dem hade varit exakt den betydelseglidning CLAUDE.md varnar för:
//
//     ChangePasswordSchema         vad FORMULÄRET ska godta
//     ChangePasswordRequestSchema  vad som SKICKAS till servern
//
// Värdemängderna överlappar, frågorna gör det inte. Ett lån hade dessutom gjort
// `confirmPassword` till ett fält DTO:n avvisar som okänd nyckel.
//
// ── HEMLIGHETSBÄRANDE FÄLT MATCHAR DTO:N EXAKT ─────────────────────────────
//
// `newPassword` är `StrongPasswordSchema`, samma som `@IsStrongPassword()`
// härleds ur. `token` är `.min(32)`, samma som DTO:ns `@MinLength(32)`. Ett
// schema som är LÖSARE än DTO:n beskriver ett anrop servern avvisar; ett som är
// strängare beskriver ett anrop klienten aldrig gör. Båda är fel — de ska vara
// identiska, och paritetsprovet kräver det.

/** POST /auth/change-password */
export const ChangePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: StrongPasswordSchema,
  })
  .strict()

/**
 * POST /auth/reset-password
 *
 * `token` är 32+ tecken av samma skäl som DTO:n säger det: den är hela
 * behörigheten i anropet, och ett kortare värde är inte ett av våra.
 */
export const ResetPasswordRequestSchema = z
  .object({
    token: z.string().min(32),
    newPassword: StrongPasswordSchema,
  })
  .strict()

/**
 * POST /auth/accept-invite
 *
 * Samma form som återställningen, men ett ANNAT ärende: här sätts lösenordet
 * första gången, och anropet loggar med flit INTE in användaren. Två scheman och
 * inte ett delat, därför att de två kan börja skilja sig — en inbjudan kan få
 * ett namnfält, en återställning aldrig.
 */
export const AcceptInviteRequestSchema = z
  .object({
    token: z.string().min(32),
    newPassword: StrongPasswordSchema,
  })
  .strict()

/**
 * POST /auth/forgot-password
 *
 * Svaret är generiskt oavsett om adressen fanns — `.strict()` hör till den
 * egenskapen: ett extra fält som organisationsval hade gjort svaret
 * särskiljbart och därmed till en uppräkningskanal.
 */
export const ForgotPasswordRequestSchema = z.object({ email: z.string().email() }).strict()

export type ChangePasswordRequestInput = z.infer<typeof ChangePasswordRequestSchema>
export type ResetPasswordRequestInput = z.infer<typeof ResetPasswordRequestSchema>
export type AcceptInviteRequestInput = z.infer<typeof AcceptInviteRequestSchema>
export type ForgotPasswordRequestInput = z.infer<typeof ForgotPasswordRequestSchema>

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

/**
 * POST /units.
 *
 * ── VAD SOM RÄTTADES, OCH VARFÖR WEBBEN HADE EN EGEN TYP ────────────────────
 *
 * Schemat SAKNADE `propertyId` och `status` — båda finns i `CreateUnitDto`
 * (`@IsUUID() propertyId!`, `@IsEnum(UNIT_STATUSES) @IsOptional() status?`).
 * Ett schema utan `propertyId` kan inte beskriva en giltig kropp: utan
 * fastigheten vet servern inte var lägenheten hör hemma. Det är därför webben
 * bar en EGEN `CreateUnitInput` med båda fälten — den kunde inte använda den
 * här.
 *
 * `area` sa dessutom `.positive()` medan DTO:n säger `@Min(0)`. Noll var alltså
 * giltigt på servern och avvisat av schemat — en gränsvärdesskillnad som bara
 * syns på exakt det värdet.
 *
 * Schemat beskriver nu DTO:n. Det är inte en utvidgning av vad som accepteras:
 * servern tog emot precis detta hela tiden.
 */
export const CreateUnitSchema = z.object({
  propertyId: z.string().uuid(),
  name: z.string().min(1).max(200),
  unitNumber: z.string().min(1).max(50),
  type: UnitTypeSchema,
  status: UnitStatusSchema.optional(),
  /** `@Min(0)` i DTO:n — noll är giltigt (t.ex. en förrådsplats utan yta). */
  area: z.number().min(0),
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

/**
 * PATCH /tenants/:id — hyresgästens KONTAKTUPPGIFTER.
 *
 * ── VARFÖR DEN INTE ÄR `CreateTenantSchema.partial()` ───────────────────────
 *
 * Den var det, och beskrev då en form ingen skickar och servern inte tar emot.
 * Tre former var i omlopp samtidigt (mätt 2026-09-06):
 *
 *   schemat här      `address: AddressSchema` (nästlad) + `contactPerson`
 *   UpdateTenantDto  FLATA `street`/`city`/`postalCode`, inget contactPerson
 *   webben           en EGEN lokal typ med nästlad address, plattad av
 *                    `flattenUpdate` precis före anropet
 *
 * Webben plattade alltså nästlat → flatt för att träffa DTO:n, medan schemat
 * påstod något tredje. `contactPerson` var värre än kosmetiskt: DTO:n saknar
 * fältet, och pipen kör `forbidNonWhitelisted`, så ett schema-troget anrop hade
 * AVVISATS av servern.
 *
 * Schemat beskriver nu TRÅDEN — den flata formen DTO:n faktiskt tar emot. Det
 * är inte en inskränkning: ingen skickade den nästlade formen, `flattenUpdate`
 * såg till det.
 *
 * Skapandet är oförändrat: `CreateTenantSchema` behåller sin nästlade `address`
 * och sin `contactPerson`, eftersom `CreateTenantDto` har dem. De två vägarna
 * har olika form i tråden, och det är ett faktum om API:t — inte något det här
 * schemat ska dölja.
 */
export const UpdateTenantSchema = z.object({
  type: z.enum(['INDIVIDUAL', 'COMPANY']).optional(),
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  companyName: z.string().min(1).max(200).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  personalNumber: z
    .string()
    .optional()
    .refine(
      (v) => !v || isValidSwedishPersonalNumber(v),
      'Ogiltigt personnummer (kontrollera format och kontrollsiffra)',
    ),
  orgNumber: z
    .string()
    .optional()
    .refine((v) => !v || isValidSwedishOrgNumber(v), 'Ogiltigt organisationsnummer'),
  // FLAT adress — samma tre fält som DTO:n, inte AddressSchema.
  street: z.string().optional(),
  city: z.string().optional(),
  postalCode: z.string().optional(),
})

/** Avidentifiering av en hyresgäst. Skälet är frivilligt, precis som DTO:n. */
export const AnonymizeTenantSchema = z.object({
  reason: z.string().max(500).optional(),
})

// ─── Lease ────────────────────────────────────────────────────────────────────

/**
 * KONTRAKTSVILLKOREN — de fält som beskriver vad avtalet innehåller.
 *
 * Delas av `CreateLeaseSchema` och `CreateLeaseWithTenantSchema`, som båda
 * skickar dem till samma kolumner. Två kopior hade glidit isär, och det som
 * glider är avtalstexten.
 *
 * ALLA VALFRIA, INGEN MED `.default()`. Se `CreateLeaseSchema`s docblock.
 */
export const LEASE_CONTRACT_TERMS = {
  // Vad ingår i hyran
  includesHeating: z.boolean().optional(),
  includesWater: z.boolean().optional(),
  includesHotWater: z.boolean().optional(),
  includesElectricity: z.boolean().optional(),
  includesInternet: z.boolean().optional(),
  includesCleaning: z.boolean().optional(),
  includesParking: z.boolean().optional(),
  includesStorage: z.boolean().optional(),
  includesLaundry: z.boolean().optional(),
  // Tilläggsavgifter
  parkingFee: z.number().min(0).optional(),
  storageFee: z.number().min(0).optional(),
  garageFee: z.number().min(0).optional(),
  // Användning, husdjur, andrahand, försäkring
  usagePurpose: z.string().optional(),
  petsAllowed: z.enum(['ALLOWED', 'REQUIRES_APPROVAL', 'NOT_ALLOWED']).optional(),
  petsApprovalNotes: z.string().optional(),
  sublettingAllowed: z.boolean().optional(),
  requiresHomeInsurance: z.boolean().optional(),
  // Indexklausul
  indexClauseType: z.enum(['NONE', 'KPI', 'NEGOTIATED', 'MARKET_RENT']).optional(),
  indexBaseYear: z.number().int().min(1900).max(2100).optional(),
  indexAdjustmentDate: z.string().optional(),
  indexMaxIncrease: z.number().min(0).max(100).optional(),
  indexMinIncrease: z.number().min(0).max(100).optional(),
  indexNotes: z.string().optional(),
  // Särskilda bestämmelser
  specialTerms: z.string().optional(),
} as const

/** Fälten vars enda uppgift är att beskriva en indexklausul. */
const INDEXFALT = [
  'indexBaseYear',
  'indexAdjustmentDate',
  'indexMaxIncrease',
  'indexMinIncrease',
  'indexNotes',
] as const

/**
 * ÄR FÄLTET ANGIVET — eller nollställt?
 *
 * `!== undefined` räcker inte, och skillnaden var en BLOCKERARE. Webbens
 * formulär sätter `indexAdjustmentDate: ''` och `indexNotes: ''` i sina
 * defaultValues (`LeaseForm.tsx:374`, `:381`). Tom sträng är inte `undefined`,
 * så regel 2 fällde formulärets NORMALLÄGE — och eftersom de två inputfälten
 * bara renderas innanför `indexClauseType !== 'NONE'` hade felen ingen plats
 * att visas på. Utfallet: användaren trycker Spara, och ingenting händer.
 *
 * Sakligt är regeln också fel med `!== undefined`: tom sträng och null är hur
 * en klient NOLLAR ett fält, och en nollning kan aldrig vara en motsägelse.
 * Att förbjuda den gör dessutom en indexklausul omöjlig att TA BORT.
 */
const angivet = (v: unknown): boolean => v !== undefined && v !== null && v !== ''

/**
 * De fem reglerna som går att pröva UTAN att slå upp något i databasen.
 *
 * Var och en är intern konsistens i nyttolasten — inte en regel om avtalet som
 * kräver enhetens typ. Sådana regler (uppsägningstidens minimum, depositions-
 * taket, regimens giltighet) ägs av servern och får INTE dupliceras här; se
 * `CreateLeaseSchema`s docblock.
 */
export function granskaKontraktsvillkor(
  // `| undefined` uttryckligen: repot kör `exactOptionalPropertyTypes: true`,
  // och utan det matchar signaturen inte Zods `superRefine`.
  d: {
    leaseType?: 'FIXED_TERM' | 'INDEFINITE' | undefined
    startDate?: string | undefined
    endDate?: string | undefined
    renewalPeriodMonths?: number | undefined
    indexClauseType?: 'NONE' | 'KPI' | 'NEGOTIATED' | 'MARKET_RENT' | undefined
    indexMinIncrease?: number | undefined
    indexMaxIncrease?: number | undefined
  },
  ctx: z.RefinementCtx,
): void {
  // 1. Ett tidsbestämt avtal MÅSTE ha ett slutdatum (JB 12 kap 3 §). Servern
  //    kräver det redan; att spegla kravet här ger beskedet före anropet.
  //    Notera: detta SÄTTER inget värde — det kräver bara att klienten anger ett.
  if (d.leaseType === 'FIXED_TERM' && !d.endDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Ett tidsbegränsat kontrakt måste ha ett slutdatum',
      path: ['endDate'],
    })
  }

  // 2. Indexfält utan indexklausul är ett avtal som samtidigt säger "ingen
  //    indexklausul" och bär en indexformel. Motsägelsen renderas rakt in i
  //    kontraktstexten och blir en tolkningstvist.
  const harIndexklausul = d.indexClauseType != null && d.indexClauseType !== 'NONE'
  if (!harIndexklausul) {
    for (const falt of INDEXFALT) {
      if (angivet((d as Record<string, unknown>)[falt])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'Indexuppgifter kan bara anges när kontraktet har en indexklausul (indexClauseType ≠ NONE)',
          path: [falt],
        })
      }
    }
  }

  // 3. Ett tillsvidareavtal förnyas inte — det löper. Datahygien, inte lagkrav.
  if (d.leaseType === 'INDEFINITE' && d.renewalPeriodMonths != null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Förnyelseperiod kan inte anges för ett tillsvidareavtal',
      path: ['renewalPeriodMonths'],
    })
  }

  // 3b. DEN OMVÄNDA RIKTNINGEN av regel 1, som saknades: ett tillsvidareavtal
  //     med ett SLUTDATUM. Ett avtal på obestämd tid upphör genom uppsägning —
  //     ett slutdatum låter det upphöra utan, vilket är precis vad
  //     besittningsskyddet finns för att hindra. Kolumnen skrivs i dag
  //     (`leases.service.ts`, `...(dto.endDate != null ? …)`) utan att någon
  //     frågar efter avtalstypen, och `endDate`-guarden i `update()` är byggd
  //     på premissen att endDate bara finns på tidsbestämda avtal.
  //
  //     BARA vid ett UTTRYCKLIGEN satt INDEFINITE. Att härleda typen ur ett
  //     utelämnat fält vore fel i den partiella vägen: en PATCH som bara
  //     flyttar slutdatumet på ett tidsbestämt avtal skickar inget leaseType,
  //     och den ska gå igenom.
  if (d.leaseType === 'INDEFINITE' && angivet(d.endDate)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Ett tillsvidareavtal kan inte ha ett slutdatum — det upphör genom uppsägning',
      path: ['endDate'],
    })
  }

  // 5. HYRESTIDEN MÅSTE VARA EN TID.
  //
  //    Regeln bars av den gamla `.refine()`-kedjan och föll bort när de fyra
  //    ovan skrevs — i samma PR som gör schemat BINDANDE. Den finns inte heller
  //    någon annanstans i HTTP-vägen: varken `create`, `createWithTenant` eller
  //    `update` kontrollerar det (bara `renew`, på framräknade datum). AI-vägen
  //    hade den redan (`tool-executor.service.ts`), så ett avtal skapat av
  //    agenten varnades medan samma avtal skapat av en människa gick rakt in.
  //
  //    Utfallet är ett tidsbestämt avtal vars hyrestid slutar före tillträdet:
  //    aviseringen hoppar över det, utgångssvepet plockar det direkt, och
  //    kontraktet renderas med en hyrestid som inte existerar.
  if (d.startDate != null && d.endDate != null && new Date(d.endDate) <= new Date(d.startDate)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Slutdatum måste vara efter startdatum',
      path: ['endDate'],
    })
  }

  // 4. Ett golv över taket är ingen klausul.
  if (
    d.indexMinIncrease != null &&
    d.indexMaxIncrease != null &&
    d.indexMinIncrease > d.indexMaxIncrease
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Lägsta indexuppräkning kan inte överstiga den högsta',
      path: ['indexMinIncrease'],
    })
  }
}

/**
 * POST /leases.
 *
 * ── SCHEMAT SÄTTER ALDRIG EN JURIDISK DEFAULT ───────────────────────────────
 *
 * Det här är den bärande regeln, och den kommer ur en mätning. Schemat hade
 * `noticePeriodMonths: z.number().default(3)`. Tre månader är lagens minimum
 * för BOSTAD; för LOKAL är det nio (JB 12 kap 4 §, `minNoticePeriodMonths`).
 * Ett statiskt klientdefault kan alltså bara vara rätt för hälften av fallen:
 * för en lokal skickade det ett värde servern avvisar, och för en bostad låste
 * det ett tal operatören aldrig valde.
 *
 * Hyresjuristens bedömning gick längre än så, och den följs här: INGET fält får
 * ett `.default()`, inte heller de som ser regimoberoende ut. `leaseType` och
 * `tenancyRegime` har säkra serverfallbacker i dag (`?? 'INDEFINITE'`,
 * `resolveTenancyRegime()` → TENANCY_ACT), men ett duplicerat default här vore
 * en andra sanningskälla som kan glida ifrån `leases.compliance.ts` utan att
 * någon vakt fångar det — precis som `noticePeriodMonths` en gång såg
 * regimoberoende ut innan lokalstödet fanns. En fallback, ett skrivställe.
 *
 * Utelämnat fält betyder därför "operatören valde inte", och servern avgör.
 *
 * ── VAD SCHEMAT INTE FÅR VETA ───────────────────────────────────────────────
 *
 * Uppsägningstidens minimum, depositionstaket (3 månadshyror för bostad) och
 * regimens giltighet är alla funktioner av `unit.type`, som ett stateless
 * klientschema inte känner till. De ägs av `leases.compliance.ts` och
 * `resolveTenancyRegime()`. Att replikera dem här hade varit den dubblering
 * CLAUDE.md förbjuder — och den kopian hade dessutom varit den som blev fel.
 *
 * ── INGEN REGIMBEROENDE OBLIGATORISKHET ─────────────────────────────────────
 *
 * Jag skulle uttrycka regimberoende krav i `superRefine`. Juristen mätte och
 * svarade att det inte FINNS några: skillnaden mellan TENANCY_ACT och
 * PRIVATE_RENTAL ligger i uppsägningsMEKANIKEN vid uppsägningstillfället, inte
 * i vad som krävs när avtalet skapas — `assertLeaseLegalLimits` läser bara
 * `unit.type`, aldrig regimen. Att uppfinna en regel här hade varit att skriva
 * en spärr som inte motsvarar någon rättsregel.
 *
 * `indexClauseType` × bostad/lokal ÄR en verklig lucka (en indexklausul på
 * bostad utanför presumtionshyra är juridiskt tveksam), men den kräver
 * `unit.type` och saknas i dag även server-side. Egen backlogpost, inte det här
 * schemat.
 */
/**
 * Kontraktets EKONOMISKA och TIDSMÄSSIGA kärnfält — det som inte är ett
 * villkor i `LEASE_CONTRACT_TERMS` och inte en part.
 *
 * Egen konstant för att webbens formulär ska kunna komponera ur SAMMA
 * definitioner. Formuläret kan inte använda `CreateLeaseWithTenantSchema` rakt
 * av — det är PLATT (firstName, lastName … på toppnivå) medan trådformen
 * nästar hyresgästen i `newTenant`, och bär dessutom rena UI-fält
 * (`propertyId`, `tenantMode`) som aldrig går på tråden. Skillnaden är
 * strukturell, inte slarv. Men GRÄNSERNA är desamma, och genom att båda läser
 * de här objekten kan de inte glida isär.
 *
 * MÄTT GLIDNING som den här konstanten stänger: webben hade
 * `noticePeriodMonths: z.coerce.number().int().min(0).default(3)` medan DTO:n
 * kräver `@Min(1)`. Formuläret släppte alltså igenom 0 — som servern avvisar
 * med 400 i stället för med ett fältfel — och SATTE 3 månader när fältet
 * tömdes. Se `CreateLeaseSchema`s docblock om varför det senare är ett
 * påstående om avtalet och inte en bekvämlighet.
 */
export const LEASE_CORE_FIELDS = {
  monthlyRent: z.number().min(0),
  depositAmount: z.number().min(0).optional(),
  startDate: IsoDatumSchema,
  endDate: IsoDatumSchema.optional(),
  leaseType: z.enum(['FIXED_TERM', 'INDEFINITE']).optional(),
  renewalPeriodMonths: z.number().int().min(1).optional(),
  // 1–60 speglar DTO:ns @Min(1) @Max(60). MINIMUM per enhetstyp (3 bostad,
  // 9 lokal) ägs av servern — se docblocket.
  noticePeriodMonths: z.number().int().min(1).max(60).optional(),
} as const

export const CreateLeaseBaseSchema = z.object({
  unitId: z.string().uuid(),
  tenantId: z.string().uuid(),
  tenancyRegime: z.enum(['PRIVATE_RENTAL', 'TENANCY_ACT']).optional(),
  ...LEASE_CORE_FIELDS,
  ...LEASE_CONTRACT_TERMS,
})

export const CreateLeaseSchema = CreateLeaseBaseSchema.superRefine(granskaKontraktsvillkor)

/**
 * PATCH /leases/:id — partiell.
 *
 * Samma fyra konsistensregler gäller: de prövar nyttolasten mot sig själv, och
 * en partiell kropp som sätter ett indexfält utan indexklausul är lika
 * motsägelsefull som en fullständig.
 */
export const UpdateLeaseSchema =
  CreateLeaseBaseSchema.partial().superRefine(granskaKontraktsvillkor)

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
    // SAMMA definitioner som skapandevägen. Stod tidigare utskrivna här, och
    // hade redan glidit: `monthlyRent` var `.positive()` här men `.min(0)` i
    // CreateLeaseBaseSchema, alltså två olika svar på om noll kronor är en
    // giltig hyra beroende på vilken endpoint klienten råkade välja.
    ...LEASE_CORE_FIELDS,
    tenancyRegime: z.enum(['PRIVATE_RENTAL', 'TENANCY_ACT']).optional(),
    /**
     * `true` aktiverar kontraktet (DRAFT → ACTIVE) i samma anrop. Fältet fanns
     * i DTO:n och i webbens lokala typ men SAKNADES här — det delade schemat
     * kunde alltså inte beskriva ett anrop som aktiverar.
     */
    activate: z.boolean().optional(),
    // SAMMA villkorsblock som CreateLeaseSchema. Fälten fanns i DTO:n och i
    // webbens `extends ContractTerms`, men inte här — schemat kunde inte
    // beskriva ett anrop som satte något av dem.
    ...LEASE_CONTRACT_TERMS,
  })
  .superRefine((d, ctx) => {
    if (Boolean(d.existingTenantId) === Boolean(d.newTenant)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Ange antingen en befintlig hyresgäst eller uppgifter för en ny',
        path: ['existingTenantId'],
      })
    }
    // Samma fyra konsistensregler som skapandevägen — samma kolumner, samma
    // avtalstext, och därför samma krav.
    granskaKontraktsvillkor(d, ctx)
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
/**
 * REGISTRERINGENS NYTTOLAST — `z.input`, INTE `z.infer`.
 *
 * `z.infer` är `z.output`: formen EFTER att Zod tillämpat sina defaults.
 * `RegisterSchema` har tre (`companyForm`, `hasFSkatt`, `accountType`), och i
 * utdatatypen är de därför OBLIGATORISKA — trots att en klient inte behöver
 * skicka dem. Typen beskrev alltså serverns interna vy, inte tråden.
 *
 * Det syntes inte förrän DTO:n band sig till typen: `RegisterDto` har de tre
 * som valfria, vilket är rätt, och `implements` föll. Webbens egen kopia hade
 * också valfria fält — den beskrev tråden korrekt, den delade typen gjorde det
 * inte.
 *
 * REGELN: en typ som beskriver vad en KLIENT SKICKAR ska vara `z.input` när
 * schemat har defaults. `z.infer` är rätt för det servern arbetar med efteråt.
 */
export type RegisterInput = z.input<typeof RegisterSchema>
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>
export type CreatePropertyInput = z.infer<typeof CreatePropertySchema>
export type UpdatePropertyInput = z.infer<typeof UpdatePropertySchema>
export type CreateUnitInput = z.infer<typeof CreateUnitSchema>
export type CreateTenantInput = z.infer<typeof CreateTenantSchema>
export type UpdateTenantInput = z.infer<typeof UpdateTenantSchema>
export type AnonymizeTenantInput = z.infer<typeof AnonymizeTenantSchema>
export type EquipmentKind = (typeof EQUIPMENT_KINDS)[number]
export type CreateEquipmentInput = z.infer<typeof CreateEquipmentSchema>
export type RegisterReplacementInput = z.infer<typeof RegisterReplacementSchema>
export type UpdateUnitInput = z.infer<typeof UpdateUnitSchema>
export type CreateRentIncreaseInput = z.infer<typeof CreateRentIncreaseSchema>
export type RejectRentIncreaseInput = z.infer<typeof RejectRentIncreaseSchema>
// ─── Felanmälan: EN BAS, TVÅ DELMÄNGDER ──────────────────────────────────────

/**
 * MaintenanceCategory och MaintenancePriority, som VÄRDEN.
 *
 * Sanningen bor i Prisma (`schema.prisma`, `enum MaintenanceCategory`). Den här
 * listan är den delade kopian som webben, portalen och schemat läser — och den
 * är BUNDEN till Prisma av ett prov i API:t
 * (`maintenance-enum-source.spec.ts`), som kräver exakt likhet åt båda hållen.
 * `@eken/shared` kan inte importera `@prisma/client`: paketet konsumeras av tre
 * webbläsar-SPA:er.
 *
 * Kopian utan bindning är precis felet den ersätter. `tenant-ai-tools.definition.ts`
 * hade en egen uppräkning med SJU värden, varav TRE inte finns i databasen
 * (`APPLIANCE` — singular, `STRUCTURAL`, `PEST`) och fyra saknades. Värdet
 * castades `as MaintenanceCategory` utan kontroll, så en hyresgäst som skrev
 * "skadedjur" fick modellen att svara `PEST` och skrivningen att falla i
 * Postgres — ett runtime-fel som väntade på rätt ord.
 */
export const MAINTENANCE_CATEGORIES = [
  'PLUMBING',
  'ELECTRICAL',
  'HEATING',
  'APPLIANCES',
  'WINDOWS_DOORS',
  'LOCKS',
  'FACADE',
  'ROOF',
  'COMMON_AREAS',
  'CLEANING',
  'OTHER',
] as const

export const MAINTENANCE_PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const

export type MaintenanceCategoryValue = (typeof MAINTENANCE_CATEGORIES)[number]
export type MaintenancePriorityValue = (typeof MAINTENANCE_PRIORITIES)[number]

export const MaintenanceCategoryEnum = z.enum(MAINTENANCE_CATEGORIES)
export const MaintenancePriorityEnum = z.enum(MAINTENANCE_PRIORITIES)

/**
 * ÄRENDETS STATUS. Samma kopia-med-bindning som kategorierna ovan: listan är en
 * spegling av Prismas `MaintenanceStatus`, och `maintenance-enum-source.spec.ts`
 * är bindningen. Utan provet är en kopia precis det fel den ersätter.
 */
export const MAINTENANCE_STATUSES = [
  'NEW',
  'IN_PROGRESS',
  'SCHEDULED',
  'COMPLETED',
  'CLOSED',
  'CANCELLED',
] as const

/**
 * VAD AI:n FÅR SÄTTA — en DELMÄNGD, och en annan fråga än den ovan.
 *
 * `MAINTENANCE_STATUSES` svarar på "är det här ett giltigt ärendetillstånd".
 * Den här svarar på "får en assistent FLYTTA ett ärende hit". `NEW` betyder
 * otriagerat, alltså tillståndet ett ärende föds i — att flytta något dit
 * tillbaka är inte en åtgärd utan en radering av att någon tittat på det.
 *
 * Härledd, inte listad: skrivs en sjunde status i Prisma blir den automatiskt
 * sättbar, och skulle den INTE vara det är undantaget en rad här — inte en
 * andra uppräkning som glider isär. Jämför CLAUDE.md om att låna ett fält som
 * svarar på en annan fråga.
 */
export const AI_EJ_SATTBAR_MAINTENANCE_STATUS = 'NEW'

export const AI_SETTABLE_MAINTENANCE_STATUSES = MAINTENANCE_STATUSES.filter(
  (s): s is Exclude<(typeof MAINTENANCE_STATUSES)[number], 'NEW'> =>
    s !== AI_EJ_SATTBAR_MAINTENANCE_STATUS,
)

/**
 * HYRESAVINS STATUS. Prisma har SEX värden; verktygets `description` räknade upp
 * FEM — `FAILED` saknades, alltså kunde en modell aldrig fråga efter avier vars
 * utskick misslyckats. Prosan var dessutom bara prosa: fältet hade ingen `enum`,
 * så ingenting hindrade ett påhittat värde från att nå Prismas where-sats.
 */
export const RENT_NOTICE_STATUSES = [
  'PENDING',
  'SENT',
  'PAID',
  'OVERDUE',
  'CANCELLED',
  'FAILED',
] as const

export type MaintenanceStatusValue = (typeof MAINTENANCE_STATUSES)[number]
export type RentNoticeStatusValue = (typeof RENT_NOTICE_STATUSES)[number]

export const MaintenanceStatusEnum = z.enum(MAINTENANCE_STATUSES)
export const RentNoticeStatusEnum = z.enum(RENT_NOTICE_STATUSES)
export const AiSettableMaintenanceStatusEnum = z.enum(
  AI_SETTABLE_MAINTENANCE_STATUSES as unknown as readonly [string, ...string[]],
)

/**
 * BASEN — det en HYRESGÄST kan säga om sitt eget fel.
 *
 * Portalen skickar exakt de här tre fälten. De fem övriga (fastighet, lägenhet,
 * hyresgäst, prioritet, datum, kostnad) HÄRLEDS server-side ur det aktiva
 * avtalet — hyresgästen ska inte kunna peka ut en annan fastighet än sin egen,
 * och prioriteten är hyresvärdens bedömning, inte anmälarens.
 *
 * Taken är inte kosmetiska. `description` hade `@MinLength(10)` men inget tak,
 * och med Fastifys 1 MiB kan en anmälan spränga skuggagentens kontextfönster —
 * kostnaden per ärende blir då obunden uppåt.
 */
export const CreateTicketBaseSchema = z
  .object({
    title: z.string().min(3).max(200),
    description: z.string().min(10).max(4000),
    category: MaintenanceCategoryEnum.optional(),
  })
  // ── .strict() ÄR EN BEHÖRIGHETSGRÄNS HÄR, INTE PEDANTERI ─────────────────
  //
  // Zods `.object()` STRYPER okända nycklar i tysthet; DTO:n avvisar dem
  // (`forbidNonWhitelisted`). För portalen är skillnaden inte kosmetisk: en
  // hyresgäst som skickar `propertyId` ska få NEJ, inte få fältet bortstruket
  // utan besked. Schemat och DTO:n måste svara likadant, annars beskriver
  // schemat ett anrop servern avvisar.
  //
  // `.extend()` ärver strikthet, så ägarvägen blir strikt av samma rad.
  .strict()

/**
 * ÄGARENS väg: basen plus de sex fält bara en hyresvärd får bestämma.
 *
 * `.extend()` och inte en egen uppräkning — delmängdsrelationen ska vara en
 * FÖLJD av konstruktionen, inte något ett prov råkar kontrollera. Provet
 * härleder den i sin tur ur schemana (`Object.keys`), så det finns ingen
 * handskriven lista någonstans i kedjan.
 */
export const CreateTicketSchema = CreateTicketBaseSchema.extend({
  propertyId: z.string().uuid(),
  unitId: z.string().uuid().optional(),
  tenantId: z.string().uuid().optional(),
  priority: MaintenancePriorityEnum.optional(),
  scheduledDate: IsoDatumSchema.optional(),
  estimatedCost: z.number().min(0).optional(),
})

/** Portalens väg ÄR basen. Ingen egen form, ingen egen gräns. */
export const SubmitTicketSchema = CreateTicketBaseSchema

/** De sex fält som skiljer ägarens väg från hyresgästens. Härledd, inte listad. */
export const TICKET_OWNER_ONLY_FIELDS = Object.keys(CreateTicketSchema.shape).filter(
  (k) => !(k in CreateTicketBaseSchema.shape),
) as ReadonlyArray<keyof (typeof CreateTicketSchema)['shape']>

/** POST /maintenance/:id/comments — hade INGEN DTO alls. */
export const AddTicketCommentSchema = z.object({
  content: z.string().min(1).max(4000),
  isInternal: z.boolean().optional(),
})

/** POST /portal/maintenance/:id/comment — hyresgästen kan inte skriva internt. */
export const AddTenantCommentSchema = z
  .object({
    content: z.string().min(1).max(4000),
  })
  // Strikt av samma skäl: `isInternal` ska AVVISAS, inte tyst strykas.
  .strict()

export type CreateTicketBaseInput = z.infer<typeof CreateTicketBaseSchema>
export type CreateTicketInput = z.infer<typeof CreateTicketSchema>
export type SubmitTicketInput = z.infer<typeof SubmitTicketSchema>
export type AddTicketCommentInput = z.infer<typeof AddTicketCommentSchema>
export type AddTenantCommentInput = z.infer<typeof AddTenantCommentSchema>

// ─── Hyresgästportalens inbjudningar (admin) ─────────────────────────────────

/**
 * POST /tenant-portal/admin/invitations
 *
 * Två sätt att välja mottagare, och de utesluter varandra: `all` bjuder in
 * varje hyresgäst med minst ett aktivt kontrakt, `tenantIds` ett uttryckligt
 * urval. `force` kringgår 24-timmarsskyddet mot dubbelklick.
 *
 * TAKET 2000 är inte pynt. Ett massutskick går till riktiga människors
 * e-postadresser, och ett urval utan tak är ett utskick vars storlek ingen
 * bestämt. Samma tal står i DTO:ns `@ArrayMaxSize` — de härleds ur varandra
 * genom `SammaNycklar` på nycklarna och prövas på GRÄNSERNA av
 * paritetsprovet i KONTRAKTSREGISTER.
 */
export const INVITE_BATCH_MAX = 2000

export const InviteTenantsSchema = z
  .object({
    all: z.boolean().optional(),
    tenantIds: z.array(z.string().uuid()).max(INVITE_BATCH_MAX).optional(),
    force: z.boolean().optional(),
  })
  .superRefine((d, ctx) => {
    // Varken urval eller "alla" är inget utskick — men det såg ut som ett
    // lyckat anrop: servern svarade 201 med noll inbjudna.
    if (!d.all && !d.tenantIds?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Ange antingen alla hyresgäster eller ett urval att bjuda in',
        path: ['tenantIds'],
      })
    }
    if (d.all && d.tenantIds?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Ange antingen alla hyresgäster eller ett urval — inte båda',
        path: ['tenantIds'],
      })
    }
  })

/** POST /tenant-portal/admin/invitations/resend */
export const ResendInvitesSchema = z
  .object({
    tenantIds: z.array(z.string().uuid()).max(INVITE_BATCH_MAX).optional(),
    onlyNotActivated: z.boolean().optional(),
  })
  .superRefine((d, ctx) => {
    if (!d.onlyNotActivated && !d.tenantIds?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Ange ett urval eller kryssa i att bara ej aktiverade ska få nytt utskick',
        path: ['tenantIds'],
      })
    }
  })

export type InviteTenantsInput = z.infer<typeof InviteTenantsSchema>
export type ResendInvitesInput = z.infer<typeof ResendInvitesSchema>

export type CreateLeaseInput = z.infer<typeof CreateLeaseSchema>
export type UpdateLeaseInput = z.infer<typeof UpdateLeaseSchema>
export type TransitionLeaseStatusInput = z.infer<typeof TransitionLeaseStatusSchema>
export type TerminateLeaseInput = z.infer<typeof TerminateLeaseSchema>
export type RenewLeaseInput = z.infer<typeof RenewLeaseSchema>
export type UpdateAppendixInput = z.infer<typeof UpdateAppendixSchema>
export type CreateSigningRequestInput = z.infer<typeof CreateSigningRequestSchema>
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

// DTO:n äger gränserna: tom referens/beskrivning tillåts, netto minst 0.01.
// Avi-radens XOR gäller consumptionChargeId/miscChargeId i service-lagret;
// dessa fält ingår inte i skapandekontraktet.
export const CreateMiscChargeSchema = z
  .object({
    leaseId: z.string().uuid({ message: 'Välj ett hyresavtal' }),
    tenantId: z.string().uuid({ message: 'Välj en hyresgäst' }),
    sourceType: MiscChargeSourceEnum,
    sourceRefId: z.string().max(64),
    description: z.string().max(500, 'Högst 500 tecken'),
    incidentDate: IsoDatumSchema,
    netAmount: z.number().finite().min(0.01, 'Beloppet måste vara minst 0,01'),
  })
  .strict()

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

// Period- och balansspärrar ligger kvar i tjänsterna. Ingen default:
// betalningsdatumet väljs av människan och daterar verifikatet.
export const PaySupplierInvoiceSchema = z.object({ paidDate: IsoDatumSchema }).strict()

export const ReverseEntrySchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(10, 'Skälet måste vara minst 10 tecken')
      .max(300, 'Skälet får vara högst 300 tecken'),
  })
  .strict()
export type ReverseEntryInput = z.infer<typeof ReverseEntrySchema>

export const ReopenPeriodSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(10, 'Skälet måste vara minst 10 tecken')
      .max(500, 'Skälet får vara högst 500 tecken'),
    reasonCategory: z.enum(['MISSING_ENTRY', 'EXISTING_ENTRY_INCORRECT']),
  })
  .strict()
export type ReopenPeriodInput = z.infer<typeof ReopenPeriodSchema>

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

/**
 * BETALNINGSSÄTTET — EN uppräkning för båda pengavägarna.
 *
 * Fanns tidigare i två oförenliga former: avin tog enumvärdet (`'BANK'`) mot
 * `@IsEnum(PaymentMethod)`, fakturan tog en etikett (`'Bankgiro'`) mot fri text
 * som `toPaymentMethod` mappade tyst. Samma fältnamn, samma handling —
 * registrera en manuell betalning — och två värdemängder som inte gick att
 * skicka mellan varandra: fakturans värde gav 400 hos avin, avins värde blev
 * `MANUAL` hos fakturan (glidning G3, mätt i #801/#805).
 *
 * Värdena speglar Prisma-enumen `PaymentMethod`. Den är GROVARE än de fem
 * alternativ gränssnittet erbjuder — bankgiro, plusgiro och autogiro är alla
 * `BANK` — och därför bär nyttolasten också `paymentMethodRaw`, se nedan.
 */
export const PaymentMethodSchema = z.enum(['BANK', 'CASH', 'SWISH', 'MANUAL'])

/**
 * Minsta längd på skälet till en sen bokföring i ett stängt räkenskapsår.
 *
 * ETT tal, läst av BÅDA Zod-schemana och BÅDA DTO:erna. Det stod tidigare
 * hårdkodat som `10` på fyra ställen plus en oanvänd konstant i
 * `closed-period.ts` som såg ut som källan men inte lästes av något — precis
 * den form CLAUDE.md varnar för: två kopior av en gräns är en gräns som glider
 * isär.
 *
 * Talet är ett EGET beslut och delas medvetet INTE med periodåteröppningens
 * `reason`-gräns, trots att båda råkar vara 10 i dag: de svarar på olika frågor
 * och ska kunna ändras var för sig.
 */
export const SEN_BOKFORING_MIN_SKAL = 10
export const SEN_BOKFORING_MAX_SKAL = 500

export const RegisterPaymentSchema = z.object({
  /** Inbetalt belopp i kronor. Grindas mot restskulden server-side. */
  amount: z.number().positive('Beloppet måste vara större än noll'),
  /**
   * SAMMA ENUM SOM AVIN sedan G3 stängdes. Utelämnat betyder `MANUAL` — "inte
   * angivet" och "manuellt registrerat" är samma sak här, och den defaulten
   * sätts på ETT ställe i tjänsten, inte av en textmappning.
   */
  paymentMethod: PaymentMethodSchema.optional(),
  /**
   * RÅTEXTEN operatören valde, t.ex. `'Plusgiro'`.
   *
   * Enumen är grövre än gränssnittet: bankgiro, plusgiro och autogiro blir alla
   * `BANK`. Tidigare KASTADES skillnaden — `toPaymentMethod` mappade och det
   * valda ordet fanns sedan ingenstans. Nu sparas det bredvid enumen, så
   * avstämningen behåller information den redan hade.
   */
  paymentMethodRaw: z.string().max(60).optional(),
  /** OCR eller annan referens. Utelämnad faller servern tillbaka på OCR-numret. */
  reference: z.string().optional(),
  /**
   * Betalningsdatum. Utelämnat: nu.
   *
   * UNIONEN ÄR MÄTT, inte vald på känsla. DTO:n har `@IsDateString()`, och den
   * accepterar BÅDE `2026-09-01` och `2026-09-01T10:30:00+02:00`. Ett enkelt
   * `z.string().datetime()` hade avvisat den första — alltså en glidning åt
   * andra hållet, där webben stoppar något servern gärna tar emot. Uppmätt över
   * sex former; unionen och `@IsDateString()` ger samma svar på alla sex.
   *
   * Ett blankt `z.string()` hade å andra sidan inte validerat något alls, vilket
   * var läget innan granskningen.
   */
  paidAt: IsoDatumSchema.optional(),
  /**
   * OPERATÖRENS SKÄL till att bokföra en betalning som inträffade i ett STÄNGT
   * RÄKENSKAPSÅR på första öppna dag.
   *
   * Fältets NÄRVARO är samtycket — ingen separat boolean, därför att ett ja
   * utan skäl inte är ett spår. Utelämnat är beteendet oförändrat: spärren
   * avvisar betalningen precis som förut.
   *
   * Kräver OWNER, samma nivå som att återöppna en period, och av ett starkare
   * skäl: ett stängt räkenskapsår kan inte öppnas igen, så beslutet går inte
   * att ångra.
   *
   * Minst 10 tecken — skälet sparas i `LateFiscalYearPosting` och ska gå att
   * förstå av en revisor långt efteråt.
   */
  senBokforingSkal: z.string().min(SEN_BOKFORING_MIN_SKAL).max(SEN_BOKFORING_MAX_SKAL).optional(),
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

export type PaymentMethodInput = z.infer<typeof PaymentMethodSchema>
export type RegisterPaymentInput = z.infer<typeof RegisterPaymentSchema>
export type CreditNoteLineInput = z.infer<typeof CreditNoteLineSchema>
export type CreateCreditNoteInput = z.infer<typeof CreateCreditNoteSchema>

// ─── Depositioner ─────────────────────────────────────────────────────────────
//
// Pengaflöde med två steg och en invariant: återbetalning + avdrag måste summera
// till depositionsbeloppet. Den invarianten kan INTE bo i schemat — den jämför
// mot ett belopp i databasen — och grindas server-side
// (`deposits.service.ts:665-670`). Schemat beskriver formen; servern äger regeln.

export const DepositDeductionSchema = z.object({
  reason: z.string().min(1, 'Ange vad avdraget avser').max(200, 'Högst 200 tecken'),
  amount: z.number().min(0, 'Avdrag får inte vara negativa'),
})

export const CreateDepositSchema = z.object({
  leaseId: z.string().uuid('Välj ett hyresavtal'),
  /** Utelämnat: servern tar depositionsbeloppet ur avtalet. */
  amount: z.number().min(1, 'Beloppet måste vara minst 1 krona').optional(),
  notes: z.string().max(1000, 'Anteckningen får vara högst 1000 tecken').optional(),
})

export const RefundDepositSchema = z.object({
  /** Noll är giltigt och betyder FÖRVERKAD deposition — inte "ingen åtgärd". */
  refundAmount: z.number().min(0, 'Återbetalningsbelopp får inte vara negativt'),
  deductions: z.array(DepositDeductionSchema).optional(),
  notes: z.string().max(1000, 'Anteckningen får vara högst 1000 tecken').optional(),
})

export type DepositDeductionInput = z.infer<typeof DepositDeductionSchema>
export type CreateDepositInput = z.infer<typeof CreateDepositSchema>
export type RefundDepositInput = z.infer<typeof RefundDepositSchema>

// ─── Inkasso: export och påminnelsestyrning ───────────────────────────────────
//
// Bindande handlingar i kravtrappan. `bulk-export` skickar fordringar till
// inkasso; grinden mot att exportera något som inte är förfallet ligger i
// tjänsten (INV-D), inte här — schemat beskriver formen, inte behörigheten.

export const BulkExportSchema = z.object({
  invoiceIds: z.array(z.string().uuid('Varje faktura-id måste vara ett UUID')),
})

export const PauseRemindersSchema = z.object({
  /** Fri text. Loggas på fakturan så att pausen går att förklara i efterhand. */
  reason: z.string().optional(),
})

export const MarkSentSchema = z.object({
  /** Utelämnad eller ifylld — men inte tom sträng; DTO:n har @MinLength(1). */
  note: z.string().min(1, 'Anteckningen kan inte vara tom').optional(),
})

export type BulkExportInput = z.infer<typeof BulkExportSchema>
export type PauseRemindersInput = z.infer<typeof PauseRemindersSchema>
export type MarkSentInput = z.infer<typeof MarkSentSchema>

// ─── Hyresavier: generering, utskick, betalning och kreditering ───────────────

export const GenerateNoticesSchema = z.object({
  month: z.number().int().min(1, 'Månad är 1–12').max(12, 'Månad är 1–12'),
  year: z.number().int().min(2020, 'Året måste vara 2020 eller senare'),
})

export const SendNoticesSchema = z.object({
  noticeIds: z.array(z.string().uuid('Varje avi-id måste vara ett UUID')),
})

/**
 * Betalsättet är `PaymentMethodSchema` — SAMMA uppräkning som fakturans sedan
 * G3 stängdes. Skillnaden mot avin är att avin KRÄVER fältet; fakturan tillåter
 * att det utelämnas och tolkar det som `MANUAL`.
 */
// ─── Utrustning ──────────────────────────────────────────────────────────────
//
// `EQUIPMENT_KINDS` stod i TVÅ oberoende deklarationer: webbens
// `equipment.api.ts:3` och API:ts `create-equipment.dto.ts:18`. De var
// identiska när jag mätte (17 värden, samma ordning) — men ingenting höll dem
// lika, och den dag någon lägger till en typ på ena stället avvisar servern ett
// värde gränssnittet erbjuder. Listan bor nu på ETT ställe.

export const EQUIPMENT_KINDS = [
  'REFRIGERATOR',
  'FREEZER',
  'STOVE',
  'DISHWASHER',
  'WASHING_MACHINE',
  'DRYER',
  'BOILER',
  'HEAT_PUMP',
  'VENTILATION',
  'ELEVATOR',
  'BATHROOM_FIXTURE',
  'KITCHEN_FIXTURE',
  'FLOORING',
  'WINDOW',
  'DOOR',
  'LOCK',
  'OTHER',
] as const

export const EquipmentKindSchema = z.enum(EQUIPMENT_KINDS)

export const CreateEquipmentSchema = z.object({
  unitId: z.string().uuid(),
  kind: EquipmentKindSchema,
  label: z.string().max(120).optional(),
  installedAt: IsoDatumSchema,
  expectedLifespanYears: z.number().int().min(1).optional(),
  serviceIntervalMonths: z.number().int().min(1).optional(),
})

/**
 * Registrering av ett BYTE. Webbens egen typ saknade `maintenanceTicketId` —
 * fältet finns i DTO:n och kopplar bytet till felanmälan som föranledde det.
 * Utan det gick kopplingen inte att sätta från gränssnittet.
 */
export const RegisterReplacementSchema = z.object({
  kind: EquipmentKindSchema.optional(),
  label: z.string().max(120).optional(),
  occurredAt: IsoDatumSchema,
  performedById: z.string().uuid().optional(),
  cost: z.number().min(0).optional(),
  attachmentUrl: z.string().max(500).optional(),
  note: z.string().max(1000).optional(),
  maintenanceTicketId: z.string().uuid().optional(),
  expectedLifespanYears: z.number().int().min(1).optional(),
  serviceIntervalMonths: z.number().int().min(1).optional(),
})

// ─── Hyreshöjningar ──────────────────────────────────────────────────────────
//
// FORMEN BINDS, BELOPPEN OCH FRISTERNA RÖRS INTE. Varje gräns nedan är avläst
// ur `CreateRentIncreaseDto` respektive `RejectRentIncreaseDto` — inte vald
// här. En hyreshöjning är en juridisk handling, och en gräns som skiljer sig
// mellan klient och server är ett fel som visar sig som ett 400 mitt i ett
// bindande beslut.

export const CreateRentIncreaseSchema = z.object({
  leaseId: z.string().uuid(),
  /** Den NYA hyran i kronor, inte höjningen. Min 1, som DTO:n. */
  newRent: z.number().min(1),
  /** Motiveringen hyresgästen får se. 3–500 tecken, som DTO:n. */
  reason: z.string().min(3).max(500),
  effectiveDate: IsoDatumSchema,
  // INGET `notes`. DTO:n hade fältet, men `RentIncrease` saknar kolumn och
  // `create()` läste det aldrig — det slängdes. Det är borttaget ur DTO:n i
  // samma ändring; se dess docblock för varför det INTE räckte att ta in det
  // här. Ett spöke som paritetskontrollen legitimerar är värre än inget fält.
})

export const RejectRentIncreaseSchema = z.object({
  /** OBLIGATORISK, 2–500 tecken. Ett avslag utan skäl är inte spårbart. */
  rejectionReason: z.string().min(2).max(500),
})

// ─── Kontraktets övriga skrivvägar ───────────────────────────────────────────
//
// Fyra små kroppar som webben tidigare skickade som inline-literaler eller
// lokala typer. Varje gräns är AVLÄST ur DTO:n, inte vald här.

/** PATCH /leases/:id/status. Enumen är DTO:ns fyra värden. */
export const TransitionLeaseStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'DRAFT', 'EXPIRED', 'TERMINATED']),
})

/**
 * PATCH /leases/:id/terminate — hyresvärdens uppsägning.
 *
 * BÅDA fälten valfria, precis som DTO:n. `effectiveDate` utelämnat betyder att
 * servern räknar fram slutdatumet ur uppsägningstiden; att kräva det här hade
 * tyst tagit bort den vägen. Samma resonemang som för uppsägningsBEGÄRAN
 * (`ApproveTerminationSchema`).
 */
export const TerminateLeaseSchema = z.object({
  terminationReason: z.string().max(500).optional(),
  effectiveDate: IsoDatumSchema.optional(),
})

/** PATCH /leases/:id/renew. */
export const RenewLeaseSchema = z.object({
  newEndDate: IsoDatumSchema.optional(),
  monthlyRent: z.number().min(0).optional(),
})

/** PATCH /contracts/:leaseId/appendices/:documentId. */
export const UpdateAppendixSchema = z.object({
  attachedToLeaseAsAppendix: z.boolean().optional(),
  category: z
    .enum(['ENERGY_DECLARATION', 'HOUSE_RULES', 'INSPECTION_PROTOCOL', 'OTHER'])
    .optional(),
  appendixOrder: z.number().int().min(0).optional(),
})

/** POST /signing/requests. */
export const CreateSigningRequestSchema = z.object({
  documentId: z.string().uuid('documentId måste vara ett giltigt UUID'),
})

// ─── Uppsägningar ────────────────────────────────────────────────────────────
//
// FORMEN BINDS, BETYDELSEN RÖRS INTE. Båda fälten nedan är valfria i dag och
// förblir det: `effectiveDate` utelämnat betyder att servern BERÄKNAR ett
// förslag (senare av hyresgästens önskade datum och idag + uppsägningstid), och
// att göra fältet obligatoriskt här hade tyst tagit bort den vägen. Defaulten är
// juridik, inte kontraktsform.

export const ApproveTerminationSchema = z.object({
  /**
   * Bindande slutdatum, bekräftat av hyresvärden. Utelämnat → servern föreslår.
   * Unionen speglar DTO:ns `@IsDateString()`, som tar både `2026-09-01` och en
   * full tidsstämpel — samma mätning som för `paidAt` i #808.
   */
  effectiveDate: IsoDatumSchema.optional(),
  terminationReason: z.string().max(500).optional(),
})

export const RejectTerminationSchema = z.object({
  /** Frivillig motivering. Mejlas till hyresgästen; persisteras inte. */
  reason: z.string().max(500).optional(),
})

export const MarkNoticePaidSchema = z.object({
  paidAmount: z.number().min(0.01, 'Beloppet måste vara större än noll'),
  paymentMethod: PaymentMethodSchema,
  paidAt: IsoDatumSchema.optional(),
  /**
   * Skäl till sen bokföring i ett STÄNGT RÄKENSKAPSÅR — samma fält, samma
   * betydelse och samma rollkrav som på fakturavägen. Se
   * `RegisterPaymentSchema.senBokforingSkal`.
   */
  senBokforingSkal: z.string().min(SEN_BOKFORING_MIN_SKAL).max(SEN_BOKFORING_MAX_SKAL).optional(),
})

export const RentNoticeCreditLineSchema = z.object({
  /** Utelämnad = hyreskapitalet. */
  rentNoticeLineId: z.string().uuid('rentNoticeLineId måste vara ett giltigt UUID').optional(),
  /** Brutto i kronor. */
  amount: z
    .number()
    .multipleOf(0.01, 'Belopp anges med högst två decimaler')
    .min(0.01, 'Belopp måste vara större än noll'),
})

export const CreateRentNoticeCreditSchema = z.object({
  lines: z.array(RentNoticeCreditLineSchema).min(1, 'En kreditering måste innehålla minst en post'),
  reason: z.string().min(5, 'Ange ett skäl till krediteringen (minst 5 tecken)'),
})

export type GenerateNoticesInput = z.infer<typeof GenerateNoticesSchema>
export type SendNoticesInput = z.infer<typeof SendNoticesSchema>
export type ApproveTerminationInput = z.infer<typeof ApproveTerminationSchema>
export type RejectTerminationInput = z.infer<typeof RejectTerminationSchema>
export type MarkNoticePaidInput = z.infer<typeof MarkNoticePaidSchema>
export type RentNoticeCreditLineInput = z.infer<typeof RentNoticeCreditLineSchema>
export type CreateRentNoticeCreditInput = z.infer<typeof CreateRentNoticeCreditSchema>

// ─── Bankavstämning: manuell matchning och PDF-import ─────────────────────────

/**
 * MANUELL MATCHNING mot en faktura ELLER en avi.
 *
 * Regeln "exakt en av dem" står MEDVETET inte här. Den finns i
 * `reconciliation.service.ts:2303-2309` och gäller båda riktningarna (ingen
 * angiven / båda angivna). Att lägga en `.refine()` här hade gjort schemat
 * STRÄNGARE än DTO:n, alltså en glidning åt andra hållet — webben stoppar något
 * servern beskriver som giltigt — och hela serien bygger på att de två
 * beskrivningarna säger samma sak. Samma gränsdragning som depositionernas
 * summainvariant: servern äger regeln, schemat äger formen.
 */
export const ManualMatchSchema = z.object({
  invoiceId: z.string().uuid('invoiceId måste vara ett UUID').optional(),
  rentNoticeId: z.string().uuid('rentNoticeId måste vara ett UUID').optional(),
})

export const EditedTransactionSchema = z.object({
  date: z.string(),
  description: z.string(),
  /**
   * NULL och SAKNAD är olika saker här: DTO:n har `ocr?: string | null`, alltså
   * kan fältet skickas som `null` för att säga "ingen OCR" — inte bara utelämnas.
   */
  ocr: z.string().nullable().optional(),
  amount: z.number(),
  isIncoming: z.boolean().optional(),
})

export const ConfirmImportSchema = z.object({
  /** Utelämnad = bekräfta utkastet som det står. */
  transactions: z.array(EditedTransactionSchema).optional(),
})

export type ManualMatchInput = z.infer<typeof ManualMatchSchema>
export type EditedTransactionInput = z.infer<typeof EditedTransactionSchema>
export type ConfirmImportInput = z.infer<typeof ConfirmImportSchema>

// ─── Besiktningar ─────────────────────────────────────────────────────────────

/**
 * BESIKTNINGENS ENUMS — kopior av Prismas, bundna av ett prov.
 *
 * Samma skäl som felanmälans (`MAINTENANCE_CATEGORIES` ovan): `@eken/shared`
 * kan inte importera `@prisma/client`, eftersom paketet konsumeras av tre
 * webbläsar-SPA:er. Bindningen är därför `inspection-enum-source.spec.ts`, som
 * kräver LIKHET ÅT BÅDA HÅLLEN — en delmängdskontroll ser inte det som saknas.
 *
 * De tre listorna fanns redan i tre kopior: Prisma, webbens
 * `inspections.api.ts` och ägar-AI:ns verktygsdefinition. De två senare läser
 * nu de här.
 */
export const INSPECTION_TYPES = ['MOVE_IN', 'MOVE_OUT', 'PERIODIC', 'DAMAGE'] as const
export const INSPECTION_STATUSES = ['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'SIGNED'] as const
export const INSPECTION_ITEM_CONDITIONS = ['GOOD', 'ACCEPTABLE', 'DAMAGED', 'MISSING'] as const

export type InspectionTypeValue = (typeof INSPECTION_TYPES)[number]
export type InspectionStatusValue = (typeof INSPECTION_STATUSES)[number]
export type InspectionItemConditionValue = (typeof INSPECTION_ITEM_CONDITIONS)[number]

export const InspectionTypeEnum = z.enum(INSPECTION_TYPES)
export const InspectionStatusEnum = z.enum(INSPECTION_STATUSES)
export const InspectionItemConditionEnum = z.enum(INSPECTION_ITEM_CONDITIONS)

/**
 * TAKET PÅ BESIKTNINGENS FRITEXT.
 *
 * Ett tal, inte tre. Kolumnerna är `@db.Text`, alltså utan egen gräns, och
 * Fastifys 1 MiB är då enda spärren — samma form som felanmälans `description`
 * hade innan #828. Talet ÄR felanmälans: en anteckning i ett besiktnings-
 * protokoll är samma sorts text som en felbeskrivning, och två närliggande tal
 * utan skäl är två tal någon senare måste förklara.
 */
export const INSPECTION_TEXT_MAX = 4000

/**
 * REPARATIONSKOSTNADENS ÖVRE GRÄNS ÄR KOLUMNENS, INTE EN ÅSIKT.
 *
 * `InspectionItem.repairCost` är `Decimal(10, 2)` — tio siffror, två decimaler,
 * alltså högst 99 999 999,99. DTO:n hade bara `@IsNumber()`, så ett större tal
 * passerade valideringen och föll först i Postgres som `numeric field overflow`
 * — ett 500-fel om ett värde en operatör skrev in i ett vanligt fält.
 */
export const REPAIR_COST_MAX = 99_999_999.99

export const CreateInspectionSchema = z
  .object({
    type: InspectionTypeEnum,
    scheduledDate: IsoDatumSchema,
    propertyId: z.string().uuid(),
    unitId: z.string().uuid(),
    leaseId: z.string().uuid().optional(),
    tenantId: z.string().uuid().optional(),
  })
  .strict()

/**
 * PATCH /inspections/:id — och det fält som INTE står här.
 *
 * `completedAt` fanns i DTO:n men i ingen klient. Tjänsten skriver
 * `completedAt: new Date()` när status går till COMPLETED och lät sedan
 * klientens värde skriva över det på raden efter — alltså kunde den som anropar
 * endpointen datera slutförandet av ett besiktningsprotokoll fritt, bakåt eller
 * framåt. Protokollet är ett bevismedel i en depositionstvist; tidpunkten ska
 * komma från servern.
 *
 * SIGNATURFÄLTEN står kvar, med tak. Mätt: ingen kod SKRIVER dem (ingen UI,
 * inget AI-verktyg, ingen portal) och ingen kod LÄSER dem — PDF:en ritar tomma
 * linjer för signering på papper. De är alltså en accepterad men obrukad
 * skrivväg, och taket 200 säger vad fältet är: ett NAMN, inte en bild. En ritad
 * signatur hör hemma i `InspectionImage`, som redan finns och lagrar i R2.
 *
 * VAD SOM SKULLE ÄNDRA BESLUTET: att en signaturruta byggs i webben. Då är
 * frågan var bilden bor, inte hur långt fältet får vara.
 */
export const UpdateInspectionSchema = z
  .object({
    status: InspectionStatusEnum.optional(),
    notes: z.string().max(INSPECTION_TEXT_MAX).optional(),
    overallCondition: z.string().max(INSPECTION_TEXT_MAX).optional(),
    signedAt: IsoDatumSchema.optional(),
    tenantSignature: z.string().max(200).optional(),
    landlordSignature: z.string().max(200).optional(),
  })
  .strict()

/**
 * PATCH /inspections/:id/items/:itemId
 *
 * `repairCost` är NULLBAR med flit, och det är inte samma sak som utelämnad:
 * fältet i webben är ett `<input type="number">` vars tomma värde skickas som
 * `null` för att NOLLSTÄLLA en tidigare kostnad. `@IsOptional()` i
 * class-validator hoppar över både `null` och `undefined`, så DTO:n släppte
 * redan igenom det — schemat måste säga samma sak, annars beskriver det ett
 * anrop webben gör varje gång någon tömmer rutan.
 */
export const UpdateInspectionItemSchema = z
  .object({
    condition: InspectionItemConditionEnum.optional(),
    notes: z.string().max(INSPECTION_TEXT_MAX).optional(),
    repairCost: z.number().min(0).max(REPAIR_COST_MAX).nullable().optional(),
  })
  .strict()

export type CreateInspectionInput = z.infer<typeof CreateInspectionSchema>
export type UpdateInspectionInput = z.infer<typeof UpdateInspectionSchema>
export type UpdateInspectionItemInput = z.infer<typeof UpdateInspectionItemSchema>

// ─── Dokument ─────────────────────────────────────────────────────────────────

/**
 * POST /documents/:id/send-to-tenant
 *
 * Webben skickade en INLINE-LITERAL `{ tenantId, notify }` — ingen typ alls, på
 * den enda vägen där en hyresvärd med ett klick lägger ett dokument i en annan
 * människas portal och skickar ett mejl om det.
 *
 * `notify` UTELÄMNAD BETYDER JA, normaliserat i controllern (`dto.notify !==
 * false`) därför att leveransprimitiven själv läser `if (input.notify && …)` och
 * alltså hade tolkat ett utelämnat fält som NEJ — medan AI-verktyget tolkade det
 * som JA. Schemat beskriver formen; defaulten bor kvar i controllern, som är
 * den som känner båda anroparna. Se `send-document-to-tenant.dto.ts`.
 *
 * Uppladdningen (`POST /documents`) står MEDVETET inte här: den är multipart,
 * och dess fält är `FormData`-nycklar — inte en JSON-kropp ett Zod-schema kan
 * beskriva. `UploadDocumentDto` validerar dem efter multipart-tolkningen.
 */
export const SendDocumentToTenantSchema = z
  .object({
    tenantId: z.string().uuid(),
    notify: z.boolean().optional(),
  })
  .strict()

export type SendDocumentToTenantInput = z.infer<typeof SendDocumentToTenantSchema>

// ─── Hyresgästportalens INLOGGNINGSYTA ───────────────────────────────────────
//
// De nio schemana nedan beskriver portalens skrivanrop mot `/tenant-portal/*`.
// Ytan är hyresgästens, alltså den enda i systemet en OINLOGGAD utomstående kan
// nå: sex av de nio kräver ingen session, och tre av dem bär ett lösenord.
//
// ── VARFÖR `.strict()` PÅ ALLA NIO ──────────────────────────────────────────
//
// Samma skäl som `CreateTicketBaseSchema` (#828), fast skarpare här. Zods
// `.object()` STRYPER okända nycklar i tysthet; DTO:n avvisar dem
// (`forbidNonWhitelisted` i `main.ts`). Utan `.strict()` beskriver schemat
// alltså ett anrop servern faktiskt säger nej till — och på just den här ytan
// är den skillnaden en behörighetsgräns: `TenantLoginSchema` utan `.strict()`
// hade sagt att en klient får skicka med extra fält vid inloggning, vilket är
// precis vad en klient inte får.
//
// ── VAD SCHEMANA INTE GÖR ───────────────────────────────────────────────────
//
// De beskriver FORMEN. Lösenordsstyrkan bor kvar i
// `TenantAuthService.assertStrongPassword`, och kandidatkontrollen för
// `chooseToken` i `TenantBankIdService.choose`. Ett schema kan se att `tenantId`
// är ett uuid; det kan aldrig se om just det id:t stod i den signerade
// kandidatlistan. Skriv inte in de reglerna här — de skulle bli en andra,
// svagare kopia av en kontroll som redan finns.

/**
 * POST /tenant-portal/login
 *
 * `organizationId` är VALFRITT och är inte en behörighetsuppgift: samma
 * e-postadress kan vara hyresgäst hos två hyresvärdar, och fältet väljer vilken
 * inloggningen gäller. Servern kontrollerar ändå att adressen hör till org:en —
 * en klient som får peka ut en organisation väljer inte vem den är.
 */
export const TenantLoginSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
    organizationId: z.string().uuid().optional(),
  })
  .strict()

/**
 * POST /tenant-portal/activate
 *
 * `signatureName` är VALFRITT med flit: rena portalinbjudningar (massutskick
 * till importerade hyresgäster utan kontrakts-PDF) signerar inget kontrakt och
 * har ingen underskrift att lämna. Anges den ändå krävs minst två tecken —
 * annars vore en tom sträng en signatur.
 */
export const TenantActivateSchema = z
  .object({
    token: z.string().min(1),
    password: z.string().min(1),
    signatureName: z.string().min(2).optional(),
  })
  .strict()

/**
 * POST /tenant-portal/auth/bankid/collect och /choose
 *
 * Anropen bär providerns handtag och INGET annat — ingen `tenantId` vid
 * collect, inget personnummer någonstans. Servern avgör vem ordern gäller ur
 * uppslaget mot hyresvärdens registrerade personnummer. `.strict()` är därför
 * inte pedanteri: det är raden som gör att en klient som FÖRSÖKER skicka med en
 * identitet får nej i stället för att få den tyst bortstruken.
 *
 * ETT SCHEMA FÖR BÅDA REALMEN — operatörens `POST /auth/bankid/…/collect` och
 * hyresgästens `POST /tenant-portal/auth/bankid/collect`. Frågan är densamma:
 * är det här ett providerhandtag? De två realmen hålls isär av att ordern bär
 * sitt `purpose` och av att väljar-token har skild kryptografisk kontext
 * (#745), inte av att fältet beskrivs två gånger.
 *
 * TAKET 256 KOM FRÅN OPERATÖRSSIDAN. Hyresgästens DTO hade `@MinLength(1)` men
 * INGET tak, operatörens `@MaxLength(256)` — samma fält, samma slagning mot
 * providern, olika gränser. En obunden sträng når uppslaget lika gärna som en
 * rimlig; taket är nu detsamma på båda hållen.
 */
export const BankIdCollectSchema = z.object({ orderRef: z.string().min(1).max(256) }).strict()

/**
 * Kontovalet är undantaget från regeln ovan — här VÄLJER användaren. Att
 * `tenantId` är ett uuid är allt schemat kan se; att raden stod i den signerade
 * kandidatlistan kontrolleras i `TenantBankIdService.choose`.
 */
export const BankIdChooseSchema = z
  .object({
    chooseToken: z.string().min(1),
    tenantId: z.string().uuid(),
  })
  .strict()

/** POST /tenant-portal/forgot-password — svaret är generiskt oavsett träff. */
export const TenantForgotPasswordSchema = z.object({ email: z.string().email() }).strict()

/** POST /tenant-portal/reset-password — styrkan prövas i tjänsten, inte här. */
export const TenantResetPasswordSchema = z
  .object({
    token: z.string().min(1),
    password: z.string().min(1),
  })
  .strict()

/**
 * POST /tenant-portal/logout
 *
 * HADE INGEN DTO ALLS. Hanteraren tog `@Body() body: { sessionToken?: string }`
 * — en INLINE-TYP, som försvinner i runtime, så `ValidationPipe` hade ingen
 * metadata att läsa och validerade INGENTING. En kropp på 1 MiB skräp gick rakt
 * igenom till `if (body.sessionToken)`. Det är samma defekt `check-dto-placement`
 * finns för, en nivå värre: inte en klass på fel plats, utan ingen klass alls.
 *
 * Fältet förblir VALFRITT — en utloggning utan token är ett giltigt anrop (den
 * som redan tappat sin session ska kunna städa lokalt), och hanteraren gör
 * ingenting då. Skärpningen ligger i att allt ANNAT nu avvisas.
 */
export const TenantLogoutSchema = z.object({ sessionToken: z.string().min(1).optional() }).strict()

/**
 * POST /tenant-portal/ai/chat
 *
 * Taket 2000 är samma slag som `description` i #828: det som betalas per token
 * måste ha en övre gräns, annars är kostnaden per meddelande obunden uppåt.
 */
export const TenantChatSchema = z
  .object({
    message: z.string().min(1).max(2000),
    conversationId: z.string().optional(),
  })
  .strict()

/**
 * POST /tenant-portal/ai/confirm
 *
 * `toolInput` är avsiktligt en fri karta: den bär argumenten till det verktyg
 * `toolName` namnger, och deras former är verktygens egna. Att beskriva dem här
 * hade blivit en andra uppräkning av verktygsregistret — den sortens dubblett
 * hela kontraktsarbetet finns för att ta bort.
 *
 * `confirmed` är INTE valfri och har ingen default. Ett utelämnat fält hade
 * blivit `undefined`, och den enda säkra tolkningen av "vet ej" på en
 * bekräftelse är nej — men då hade en klientbugg sett ut som ett aktivt avslag.
 * Kravet gör skillnaden synlig i stället.
 */
export const TenantConfirmSchema = z
  .object({
    toolName: z.string().min(1),
    toolInput: z.record(z.unknown()),
    conversationId: z.string().min(1),
    confirmed: z.boolean(),
  })
  .strict()

export type TenantLoginInput = z.infer<typeof TenantLoginSchema>
export type TenantActivateInput = z.infer<typeof TenantActivateSchema>
/**
 * POST /auth/bankid/login/choose — OPERATÖRENS kontoval.
 *
 * Skild från `BankIdChooseSchema` (hyresgästens), och det är inte en dubblett:
 * fälten är olika. Hyresgästen väljer en `tenantId`, operatören ett `userId` —
 * två register, två föräldrar, två tabeller (`UserBankIdIdentity` respektive
 * `TenantBankIdIdentity`). Ett delat schema hade beskrivit ett anrop som inte
 * finns i någon av dem.
 *
 * `userId` är `.min(1).max(64)` och INTE `.uuid()`, därför att DTO:n säger så.
 * Att skärpa den här hade gjort schemat strängare än servern — och att välja
 * konto är den enda endpoint där klienten SKA skicka ett id: servern
 * kontrollerar ändå att raden stod i den signerade kandidatlistan.
 */
export const BankIdUserChooseSchema = z
  .object({
    chooseToken: z.string().min(1).max(2048),
    userId: z.string().min(1).max(64),
  })
  .strict()

export type BankIdCollectInput = z.infer<typeof BankIdCollectSchema>
export type BankIdUserChooseInput = z.infer<typeof BankIdUserChooseSchema>
export type BankIdChooseInput = z.infer<typeof BankIdChooseSchema>
export type TenantForgotPasswordInput = z.infer<typeof TenantForgotPasswordSchema>
export type TenantResetPasswordInput = z.infer<typeof TenantResetPasswordSchema>
export type TenantLogoutInput = z.infer<typeof TenantLogoutSchema>
export type TenantChatInput = z.infer<typeof TenantChatSchema>
export type TenantConfirmInput = z.infer<typeof TenantConfirmSchema>

// ─── Hantverkarregistret (etapp 10) ──────────────────────────────────────────
//
// Yrkeskategorierna ÄR `MAINTENANCE_CATEGORIES` — samma lista ärendet bär, inte
// en egen. En andra uppräkning hade glidit isär första gången någon lade till en
// kategori, och felet hade varit tyst: hantverkaren går inte att filtrera fram
// för den nya kategorin, vilket ser ut som att ingen hantverkare finns.
// `maintenance-enum-source.spec.ts` binder listan till Prismas enum.

/**
 * POST /contractors
 *
 * `name` är det enda obligatoriska. En hantverkare man just fått numret till
 * ska gå att lägga in direkt — kravet på fullständiga uppgifter hör hemma vid
 * BOKNINGEN (PR 2), som inte kan skicka en arbetsorder utan e-postadress, och
 * inte vid registreringen. Att kräva allt här hade betytt att registret står
 * tomt medan uppgifterna ligger på en lapp.
 *
 * INGET PERSONNUMMER, till skillnad från `Tenant` och `Customer`. En hantverkare
 * kontaktas i egenskap av näringsidkare, och ett personnummer hade dragit in
 * modellen i krypteringen-i-vila och i anonymiseringsvägen utan att någon
 * funktion behöver det.
 */
export const CreateContractorSchema = z
  .object({
    name: z.string().min(2).max(200),
    contactPerson: z.string().min(1).max(200).optional(),
    email: z.string().email().optional(),
    phone: z.string().min(1).max(40).optional(),
    orgNumber: z.string().min(1).max(20).optional(),
    categories: z.array(MaintenanceCategoryEnum).max(MAINTENANCE_CATEGORIES.length).optional(),
    notes: z.string().max(4000).optional(),
    isActive: z.boolean().optional(),
  })
  .strict()

/** PATCH /contractors/:id — samma form, allt valfritt. */
export const UpdateContractorSchema = CreateContractorSchema.partial().strict()

/**
 * PATCH /maintenance/:id/assign
 *
 * `contractorId` NULL betyder "ta bort tilldelningen", och det är ett giltigt
 * anrop — inte ett fel. Att kräva ett id hade gjort en felaktig tilldelning
 * omöjlig att ångra annat än genom att tilldela någon annan.
 *
 * `assignedAt` och `assignedByUserId` står MED FLIT inte här: de sätts
 * serverside. En klient som fick bestämma när något tilldelades och av vem hade
 * kunnat skriva om sin egen historik.
 */
export const AssignContractorSchema = z
  .object({
    contractorId: z.string().uuid().nullable(),
  })
  .strict()

export type CreateContractorInput = z.infer<typeof CreateContractorSchema>
export type UpdateContractorInput = z.infer<typeof UpdateContractorSchema>
export type AssignContractorInput = z.infer<typeof AssignContractorSchema>

/**
 * SVENSKA ETIKETTER FÖR YRKESKATEGORIERNA.
 *
 * `Record<MaintenanceCategoryValue, string>` — inte `Partial`, inte en lista.
 * Typen kräver VARJE nyckel, så den dag Prisma får en tolfte kategori blir det
 * ett kompileringsfel här i stället för en rå enum-sträng i hyresvärdens
 * gränssnitt. Det är samma krav som `maintenance-enum-source.spec.ts` ställer
 * på listan, fast buret av typcheckaren i stället för av ett prov.
 */
export const MAINTENANCE_CATEGORY_ETIKETT: Record<MaintenanceCategoryValue, string> = {
  PLUMBING: 'VVS',
  ELECTRICAL: 'El',
  HEATING: 'Värme',
  APPLIANCES: 'Vitvaror',
  WINDOWS_DOORS: 'Fönster och dörrar',
  LOCKS: 'Lås',
  FACADE: 'Fasad',
  ROOF: 'Tak',
  COMMON_AREAS: 'Gemensamma utrymmen',
  CLEANING: 'Städning',
  OTHER: 'Övrigt',
}

// ─── Arbetsorder till hantverkare (etapp 10, PR 2) ───────────────────────────

/**
 * POST /maintenance/:id/work-orders — SKICKA ARBETSORDER.
 *
 * `contractorId` står MED FLIT i kroppen och härleds inte ur ärendets
 * tilldelning. De två är olika handlingar: att tilldela är en anteckning, att
 * boka är ett mejl som lämnar huset. Att låta bokningen tyst använda "den som
 * råkar vara tilldelad" hade gjort mottagaren till en följd av ett tidigare
 * klick i stället för ett val man gör nu — och mottagaren är det enda som inte
 * går att ta tillbaka.
 *
 * `delaHyresgastKontakt` är default AV och är hyresvärdens uttryckliga val per
 * bokning. Fältet heter inte `samtycke`: hyresgästen har inte tillfrågats, och
 * att kalla hyresvärdens val för hyresgästens samtycke hade varit ett påstående
 * om något som inte hänt.
 */
export const SendWorkOrderSchema = z
  .object({
    contractorId: z.string().uuid(),
    meddelande: z.string().max(2000).optional(),
    delaHyresgastKontakt: z.boolean().optional(),
  })
  .strict()

/**
 * POST /work-orders/:token/respond — HANTVERKARENS SVAR.
 *
 * Publik endpoint: hantverkaren har ingen inloggning. Token är den enda
 * behörigheten, den bär bara rätten att svara på just den här ordern, och den
 * är engångs och kortlivad. Se `ContractorWorkOrder` i schemat.
 *
 * `accepterar: false` får INTE ha en `proposedAt` — ett avböjande med en
 * föreslagen tid är två motstridiga besked, och den som läser svaret skulle
 * behöva gissa vilket som gäller.
 */
export const WorkOrderResponseSchema = z
  .object({
    accepterar: z.boolean(),
    proposedAt: IsoDatumSchema.optional(),
    note: z.string().max(1000).optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (!d.accepterar && d.proposedAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Ett avböjande kan inte bära en föreslagen tid',
        path: ['proposedAt'],
      })
    }
  })

/** POST /work-orders/:id/cancel — avbokning. Se docblocket i tjänsten. */
export const CancelWorkOrderSchema = z
  .object({ skal: z.string().min(1).max(1000).optional() })
  .strict()

export type SendWorkOrderInput = z.infer<typeof SendWorkOrderSchema>
export type WorkOrderResponseInput = z.infer<typeof WorkOrderResponseSchema>
export type CancelWorkOrderInput = z.infer<typeof CancelWorkOrderSchema>

// Underhållsplaner: uppdatering har avsiktligt inget minimikrav på titeln
// och inget propertyId; den är därför inte en partial av skapandeschemat.
const MaintenancePlanCategorySchema = z.enum([
  'ROOF',
  'FACADE',
  'WINDOWS',
  'PLUMBING',
  'ELECTRICAL',
  'HEATING',
  'ELEVATOR',
  'COMMON_AREAS',
  'PAINTING',
  'FLOORING',
  'OTHER',
])
export const CreateMaintenancePlanSchema = z
  .object({
    title: z.string().min(3),
    propertyId: z.string().uuid(),
    category: MaintenancePlanCategorySchema.optional(),
    plannedYear: z.number().int().min(2020).max(2060),
    estimatedCost: z.number().finite().min(0),
    priority: z.number().int().min(1).max(3).optional(),
    interval: z.number().int().optional(),
    lastDoneYear: z.number().int().optional(),
    description: z.string().optional(),
    notes: z.string().optional(),
  })
  .strict()
export const UpdateMaintenancePlanSchema = z
  .object({
    title: z.string().optional(),
    category: MaintenancePlanCategorySchema.optional(),
    status: z.enum(['PLANNED', 'APPROVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
    plannedYear: z.number().int().min(2020).max(2060).optional(),
    estimatedCost: z.number().finite().min(0).optional(),
    actualCost: z.number().finite().min(0).optional(),
    priority: z.number().int().min(1).max(3).optional(),
    interval: z.number().int().optional(),
    lastDoneYear: z.number().int().optional(),
    description: z.string().optional(),
    notes: z.string().optional(),
    completedAt: IsoDatumSchema.optional(),
  })
  .strict()
export type CreateMaintenancePlanInput = z.infer<typeof CreateMaintenancePlanSchema>
export type UpdateMaintenancePlanInput = z.infer<typeof UpdateMaintenancePlanSchema>

export const ConfirmBackfillSchema = z
  .object({
    allowBeyondWarning: z.boolean().optional(),
    vatDeclarationAcknowledged: z.boolean().optional(),
  })
  .strict()
export type ConfirmBackfillInput = z.infer<typeof ConfirmBackfillSchema>

// reviewedData valideras vidare i importservicen, precis som före typkopplingen.
export const ConfirmContractRowSchema = z
  .object({
    unitId: z.string().uuid().optional(),
    reviewedData: z.record(z.unknown()).optional(),
  })
  .strict()
export type ConfirmContractRowInput = z.infer<typeof ConfirmContractRowSchema>

// Nyheter, meddelanden och kunder: samma form som API:ts befintliga DTO:er.
// News har inga längdgränser. null på propertyId avlägsnar fastighetsriktningen.
export const CreateNewsPostSchema = z
  .object({
    title: z.string(),
    content: z.string(),
    targetAll: z.boolean().optional(),
    propertyId: z.string().uuid().nullish(),
  })
  .strict()
export const UpdateNewsPostSchema = CreateNewsPostSchema.partial()
export type CreateNewsPostInput = z.infer<typeof CreateNewsPostSchema>
export type UpdateNewsPostInput = z.infer<typeof UpdateNewsPostSchema>

export const SendMessageSchema = z
  .object({
    tenantId: z.string().uuid().optional(),
    sendToAll: z.boolean().optional(),
    subject: z.string().min(1).max(200),
    content: z.string().min(1).max(5000),
  })
  .strict()
export type SendMessageInput = z.infer<typeof SendMessageSchema>

// personalNumber är fortsatt en valfri sträng utan nya innehållsregler.
export const CreateCustomerSchema = z
  .object({
    type: z.enum(['INDIVIDUAL', 'COMPANY']),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    personalNumber: z.string().optional(),
    companyName: z.string().optional(),
    orgNumber: z.string().optional(),
    contactPerson: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
    street: z.string().optional(),
    city: z.string().optional(),
    postalCode: z.string().optional(),
    country: z.string().optional(),
    reference: z.string().optional(),
    notes: z.string().optional(),
  })
  .strict()
export const UpdateCustomerSchema = CreateCustomerSchema.partial().extend({
  isActive: z.boolean().optional(),
})
export type CreateCustomerInput = z.infer<typeof CreateCustomerSchema>
export type UpdateCustomerInput = z.infer<typeof UpdateCustomerSchema>

// Användarroller tilldelas från samma lista som DTO:ernas @IsIn.
export const InviteUserSchema = z
  .object({
    email: z.string().email('Ogiltig e-postadress'),
    firstName: z.string().min(1, 'Förnamn krävs').max(100),
    lastName: z.string().min(1, 'Efternamn krävs').max(100),
    role: z.enum(ASSIGNABLE_ROLES),
  })
  .strict()
export type InviteUserInput = z.infer<typeof InviteUserSchema>

export const UpdateUserRoleSchema = z
  .object({
    role: z.enum(ASSIGNABLE_ROLES),
  })
  .strict()
export type UpdateUserRoleInput = z.infer<typeof UpdateUserRoleSchema>

// BuyCreditsDto tillåter tre paket, inte alla belopp mellan 100 och 1000.
export const BuyCreditsSchema = z
  .object({
    amount: z.union([z.literal(100), z.literal(500), z.literal(1000)]),
  })
  .strict()
export type BuyCreditsInput = z.infer<typeof BuyCreditsSchema>

// Nyckelkvittens: gränserna kommer från de befintliga keys-DTO:erna.
const KeyTypeSchema = z.enum([
  'APARTMENT',
  'ENTRANCE',
  'MAILBOX',
  'LAUNDRY_TAG',
  'GARAGE',
  'STORAGE',
  'FOB_TAG',
  'OTHER',
])
export const IssueKeysSchema = z
  .object({
    leaseId: z.string().uuid(),
    type: KeyTypeSchema,
    quantity: z.number().int('Antalet måste vara ett heltal').min(1).max(50),
    label: z.string().max(120).optional(),
    issuedToName: z.string().max(120).optional(),
    issuedAt: IsoDatumSchema.optional(),
    notes: z.string().max(1000).optional(),
  })
  .strict()
export const ReturnKeySchema = z
  .object({
    returnedAt: IsoDatumSchema.optional(),
    notes: z.string().max(1000).optional(),
  })
  .strict()
export const UpdateKeySchema = z
  .object({
    status: z.enum(['LOST', 'REPLACED']).optional(),
    type: KeyTypeSchema.optional(),
    label: z.string().max(120).optional(),
    issuedToName: z.string().max(120).optional(),
    notes: z.string().max(1000).optional(),
  })
  .strict()
export type IssueKeysInput = z.infer<typeof IssueKeysSchema>
export type ReturnKeyInput = z.infer<typeof ReturnKeySchema>
export type UpdateKeyInput = z.infer<typeof UpdateKeySchema>

// ─── Webbkontrakt: assistent, uppdragsbeslut, felanmälan och organisation ──────
// Samma gränser som DTO:erna. Rollkrav och krav på skäl vid avslag ägs av
// tjänsterna. IsoDatumSchema följer repo-kontraktet; äldre pipens bredare
// datumformat och skalärkoercion mäts separat i dto-contract.spec.ts.
export const CHAT_MESSAGE_MAX_LENGTH = 4000
export const CHAT_MAX_ATTACHMENTS = 5
export const ChatSchema = z
  .object({
    message: z.string().min(1).max(CHAT_MESSAGE_MAX_LENGTH),
    conversationId: z.string().uuid().optional(),
    attachmentIds: z
      .array(
        z
          .string()
          .uuid()
          .regex(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
            'Bilagans id måste vara UUID v4',
          ),
      )
      .max(CHAT_MAX_ATTACHMENTS)
      .optional(),
  })
  .strict()
export type ChatInput = z.infer<typeof ChatSchema>

export const ConfirmActionSchema = z
  .object({
    toolName: z.string(),
    toolInput: z.record(z.unknown()),
    conversationId: z.string().uuid(),
    confirmed: z.boolean(),
  })
  .strict()
export type ConfirmActionInput = z.infer<typeof ConfirmActionSchema>

export const DecideAssignmentSchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    reason: z.string().min(3).max(500).optional(),
  })
  .strict()
export type DecideAssignmentInput = z.infer<typeof DecideAssignmentSchema>

export const UpdateTicketSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    unitId: z.string().uuid().optional(),
    tenantId: z.string().uuid().optional(),
    category: MaintenanceCategoryEnum.optional(),
    priority: MaintenancePriorityEnum.optional(),
    status: MaintenanceStatusEnum.optional(),
    scheduledDate: IsoDatumSchema.optional(),
    estimatedCost: z.number().optional(),
    actualCost: z.number().optional(),
    tenantNotified: z.boolean().optional(),
  })
  .strict()
export type UpdateTicketInput = z.infer<typeof UpdateTicketSchema>

export const UpdateOrganizationSchema = z
  .object({
    bankgiro: z.string().optional(),
    paymentTermsDays: z.number().min(1).optional(),
    invoiceColor: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .optional(),
    invoiceTemplate: z.enum(['classic', 'modern', 'minimal']).optional(),
    brandFont: z.enum(BRAND_FONTS).optional(),
    brandSecondaryColor: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .optional(),
    morningReportEnabled: z.boolean().optional(),
    shadowAgentEnabled: z.boolean().optional(),
    agentExecutionEnabled: z.boolean().optional(),
    lateBookingMaterialityThreshold: z.number().int().min(0).max(1_000_000_000).optional(),
    remindersEnabled: z.boolean().optional(),
    reminderFeeSek: z.number().min(0).max(REMINDER_FEE_MAX_SEK).optional(),
    reminderFormalDay: z.number().min(1).optional(),
    reminderCollectionDay: z.number().min(1).optional(),
    collectionAgencyName: z.string().optional(),
    hasFSkatt: z.boolean().optional(),
    fSkattApprovedDate: IsoDatumSchema.optional(),
    vatNumber: z.string().optional(),
    vatReportingPeriod: z.enum(['MONTHLY', 'QUARTERLY', 'YEARLY']).optional(),
    daysBeforeMoveInForFirstPayment: z.number().min(1).optional(),
    maxBankTxAmount: z.number().min(1).max(50_000_000).optional(),
  })
  .strict()
export type UpdateOrganizationInput = z.infer<typeof UpdateOrganizationSchema>
