import { z } from 'zod'
import { api, get, post } from '@/lib/api'
import {
  fortnoxMappingInputSchema,
  fortnoxReadInputSchema,
  type FortnoxMappingInput,
  type FortnoxReadInput,
} from '@eken/shared'

const count = z.number().int().safe().nonnegative()
const ore = z.number().int().safe()
const dimension = z.enum(['COST_CENTER', 'PROJECT'])
export const readSchema = z.object({
  id: z.string().min(1),
  status: z.enum([
    'RUNNING',
    'COMPLETE',
    'COMPLETE_WITH_UNCERTAINTY',
    'PARTIAL',
    'FAILED',
    'AUTH_LOST',
    'WRONG_COMPANY',
  ]),
  financialYearId: z.number().int().positive(),
  selectedAccounts: z.array(z.number().int().positive().safe()),
  periodFrom: z.string(),
  periodTo: z.string(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  reason: z.string().nullable(),
  uncertainties: z.array(z.string()),
  coverage: z.record(
    z.object({
      pages: count,
      totalPages: count,
      totalResources: count,
      itemsSeen: count,
    }),
  ),
  summary: z
    .object({
      currency: z.literal('SEK'),
      totalOre: ore,
      byProperty: z.array(
        z.object({
          propertyId: z.string(),
          propertyName: z.string(),
          amountOre: ore,
        }),
      ),
      unmappedDimensions: z.array(
        z.object({
          dimensionType: dimension,
          code: z.string(),
          amountOre: ore,
        }),
      ),
      unallocatedOre: ore,
      uncertainRemovedOre: ore,
      evenoExportOre: ore,
    })
    .nullable(),
})

export const fortnoxStatusSchema = z.object({
  enabled: z.boolean(),
  connection: z
    .object({
      status: z.enum(['ACTIVE', 'AUTH_LOST', 'DISCONNECTED']),
      company: z.object({
        name: z.string().nullable(),
        orgNumber: z.string().nullable(),
        databaseNumber: z.number().int(),
      }),
      connectedAt: z.string(),
      disconnectedAt: z.string().nullable(),
      lastErrorClass: z.string().nullable(),
      lastErrorAt: z.string().nullable(),
    })
    .nullable(),
  mappings: z.array(
    z.object({
      id: z.string(),
      dimensionType: dimension,
      code: z.string(),
      propertyId: z.string(),
      propertyName: z.string(),
    }),
  ),
  latestRead: readSchema.nullable(),
  latestCompleteRead: readSchema.nullable(),
  exports: z.object({
    counts: z.object({
      DRY_RUN_READY: count,
      BLOCKED: count,
      UNKNOWN: count,
      CONFIRMED: count,
    }),
    needsReconciliation: count,
    sendingEnabled: z.literal(false),
    sendingDisabledReason: z.literal('IDEMPOTENCY_UNRESOLVED'),
  }),
})
export type FortnoxStatusResponse = z.infer<typeof fortnoxStatusSchema>
export type FortnoxReadView = z.infer<typeof readSchema>

export function isCivilDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  )
}
const civilDate = z.string().refine(isCivilDate, 'Ogiltigt datum')
export const fortnoxCatalogSchema = z.object({
  ready: z.boolean(),
  reason: z.string().nullable(),
  observedAt: z.string(),
  company: z.object({
    name: z.string().nullable(),
    orgNumber: z.string().nullable(),
    databaseNumber: z.number().int(),
  }),
  financialYears: z.array(
    z
      .object({
        id: z.number().int().positive().safe(),
        from: civilDate,
        to: civilDate,
      })
      .refine((year) => year.from <= year.to),
  ),
  selectedFinancialYearId: z.number().int().positive().safe().nullable(),
  costAccounts: z.array(
    z.object({
      number: z.number().int().positive().safe(),
      name: z.string(),
      selectable: z.boolean(),
      reason: z.string().nullable(),
    }),
  ),
  dimensions: z.array(
    z.object({
      dimensionType: dimension,
      code: z.string().min(1),
      name: z.string().nullable(),
    }),
  ),
  complete: z.boolean(),
})
export type FortnoxCatalogResponse = z.infer<typeof fortnoxCatalogSchema>
// Nyttolasterna är DELADE med API:t (packages/shared/src/schemas/fortnox.ts).
export { fortnoxReadInputSchema, fortnoxMappingInputSchema }
export type { FortnoxReadInput, FortnoxMappingInput }

const PREFIX = '/integrations/fortnox'

export async function getFortnoxStatus(): Promise<FortnoxStatusResponse> {
  return fortnoxStatusSchema.parse(await get<unknown>(`${PREFIX}/status`))
}

/** Server owns state/PKCE. Only the provider's authorization destination may be opened. */
export function validateFortnoxAuthUrl(value: unknown): string {
  const { authUrl } = z.object({ authUrl: z.string().url() }).parse(value)
  const url = new URL(authUrl)
  if (
    url.origin !== 'https://apps.fortnox.se' ||
    url.pathname !== '/oauth-v1/auth' ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error('Ogiltig anslutningsadress')
  }
  return url.href
}

export async function connectFortnox(): Promise<string> {
  return validateFortnoxAuthUrl(await post<unknown>(`${PREFIX}/connect`))
}

export async function disconnectFortnox(): Promise<void> {
  z.object({ disconnected: z.literal(true) }).parse(await post<unknown>(`${PREFIX}/disconnect`))
}

export async function getFortnoxCatalog(
  financialYearId: number | null,
): Promise<FortnoxCatalogResponse> {
  if (financialYearId !== null) z.number().int().positive().safe().parse(financialYearId)
  const result =
    financialYearId === null
      ? await get<unknown>(`${PREFIX}/catalog`)
      : await get<unknown>(`${PREFIX}/catalog`, { financialYearId })
  return fortnoxCatalogSchema.parse(result)
}

export async function startFortnoxRead(input: FortnoxReadInput): Promise<FortnoxReadView> {
  const body: FortnoxReadInput = fortnoxReadInputSchema.parse(input)
  return readSchema.parse(await post<unknown>(`${PREFIX}/reads`, body))
}

export async function saveFortnoxMapping(input: FortnoxMappingInput): Promise<void> {
  // Same configured Axios instance and JWT refresh as the existing helpers; there is no put helper.
  const body: FortnoxMappingInput = fortnoxMappingInputSchema.parse(input)
  await api.put(`${PREFIX}/mappings`, body)
}
