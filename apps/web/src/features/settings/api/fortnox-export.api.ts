import { z } from 'zod'
import { api, get, post } from '@/lib/api'
import {
  fortnoxDryRunInputSchema,
  fortnoxExportSettingsInputSchema,
  type FortnoxDryRunInput,
  type FortnoxExportSettingsInput,
} from '@eken/shared'

/**
 * Exportens kundval och lokala förhandskontroll (Fortnox A). Inget här skickar
 * något till Fortnox: sändning finns inte. Servern verifierar varje val på nytt.
 */
const PREFIX = '/integrations/fortnox'

const exportStateSchema = z.object({
  enabled: z.boolean(),
  connection: z
    .object({
      status: z.enum(['ACTIVE', 'AUTH_LOST', 'DISCONNECTED']),
      exportVoucherSeries: z.string().nullable(),
      exportOmitDimensions: z.boolean(),
    })
    .nullable(),
  exports: z.object({ sendingEnabled: z.literal(false), sendingDisabledReason: z.string() }),
})
export type FortnoxExportState = z.infer<typeof exportStateSchema>

const seriesCatalogSchema = z.object({
  ready: z.boolean(),
  reason: z.string().nullable(),
  financialYears: z.array(
    z.object({ id: z.number().int().positive(), from: z.string(), to: z.string() }),
  ),
  voucherSeries: z.array(z.object({ code: z.string().min(1), description: z.string().nullable() })),
})
export type FortnoxSeriesCatalog = z.infer<typeof seriesCatalogSchema>

export const exportRowSchema = z.object({
  id: z.string(),
  journalEntryId: z.string(),
  state: z.enum(['DRY_RUN_READY', 'BLOCKED', 'UNKNOWN', 'CONFIRMED']),
  blockReason: z.string().nullable(),
  updatedAt: z.string(),
})
export type FortnoxExportRow = z.infer<typeof exportRowSchema>

export async function getFortnoxExportState(): Promise<FortnoxExportState> {
  return exportStateSchema.parse(await get<unknown>(`${PREFIX}/status`))
}

export async function getFortnoxSeriesCatalog(
  financialYearId: number | null,
): Promise<FortnoxSeriesCatalog> {
  const raw =
    financialYearId === null
      ? await get<unknown>(`${PREFIX}/catalog`)
      : await get<unknown>(`${PREFIX}/catalog`, { financialYearId })
  return seriesCatalogSchema.parse(raw)
}

export async function saveFortnoxExportSettings(input: FortnoxExportSettingsInput): Promise<void> {
  const body: FortnoxExportSettingsInput = fortnoxExportSettingsInputSchema.parse(input)
  await api.put(`${PREFIX}/export-settings`, body)
}

export async function startFortnoxDryRun(input: FortnoxDryRunInput): Promise<FortnoxExportRow> {
  const body: FortnoxDryRunInput = fortnoxDryRunInputSchema.parse(input)
  return exportRowSchema.parse(await post<unknown>(`${PREFIX}/exports/dry-run`, body))
}

export async function listFortnoxExports(): Promise<FortnoxExportRow[]> {
  return z
    .object({ items: z.array(exportRowSchema) })
    .parse(await get<unknown>(`${PREFIX}/exports`)).items
}
