import { z } from 'zod'
import {
  isValidSwedishPersonalNumber,
  isValidSwedishOrgNumber,
  PASSWORD_MIN_LENGTH,
  PASSWORD_SPECIAL_CHAR_REGEX,
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

export const RegisterSchema = z.object({
  email: z.string().email('Ogiltig e-postadress'),
  password: StrongPasswordSchema,
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  organizationName: z.string().min(1).max(200),
  orgNumber: z
    .string()
    .optional()
    .refine(
      (v) => !v || isValidSwedishOrgNumber(v),
      'Ogiltigt organisationsnummer (måste följa Luhn-modulus 10)',
    ),
  accountType: z.enum(['COMPANY', 'PRIVATE']).default('COMPANY'),
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

export const AddressSchema = z.object({
  street: z.string().min(1),
  city: z.string().min(1),
  postalCode: z.string().regex(/^\d{3}\s?\d{2}$/, 'Ogiltigt postnummer'),
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
    noticePeriodMonths: z.number().int().min(0).optional(),
  })
  .refine((d) => Boolean(d.existingTenantId) !== Boolean(d.newTenant), {
    message: 'Ange antingen en befintlig hyresgäst eller uppgifter för en ny',
    path: ['existingTenantId'],
  })

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
