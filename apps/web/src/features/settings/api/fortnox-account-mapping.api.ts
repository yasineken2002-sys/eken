import { z } from 'zod'
import { get, post } from '@/lib/api'
import {
  FORTNOX_ACCOUNT_ROLES,
  FORTNOX_VAT_TREATMENTS,
  fortnoxAccountMappingApproveInputSchema,
  fortnoxAccountMappingDraftInputSchema,
  type FortnoxAccountMappingApproveInput,
  type FortnoxAccountMappingDraftInput,
} from '@eken/shared'

/**
 * TESTKUND-008: kontomappning för Fortnox-export. Nyttolasterna är DELADE med API:t
 * (samma zod-schema). Servern läser Fortnox och bedömer tekniken; klienten bevisar ingenting.
 */
const PREFIX = '/integrations/fortnox/account-mapping'

const roll = z.enum(FORTNOX_ACCOUNT_ROLES)
const behandling = z.enum(FORTNOX_VAT_TREATMENTS)

const radSchema = z.object({
  id: z.string(),
  role: roll,
  vatTreatment: behandling,
  sourceAccountNumber: z.number().int(),
  sourceAccountName: z.string(),
  targetAccountNumber: z.number().int(),
  targetName: z.string().nullable(),
  targetActive: z.boolean().nullable(),
  targetVatCode: z.string().nullable(),
  targetVatCodePresent: z.boolean(),
  targetExists: z.boolean(),
  technical: z.enum(['FORENLIG', 'KONFLIKT', 'EJ_BELAGD']),
  technicalReason: z.string(),
  approvable: z.boolean(),
  hinder: z.string().nullable(),
})
export type FortnoxAccountMappingRow = z.infer<typeof radSchema>

const revisionSchema = z.object({
  id: z.string(),
  revision: z.number().int(),
  status: z.enum(['DRAFT', 'APPROVED', 'SUPERSEDED']),
  fortnoxDatabaseNumber: z.number().int(),
  financialYearId: z.number().int(),
  financialYearFrom: z.string(),
  financialYearTo: z.string(),
  contentSha256: z.string(),
  createdByRole: z.string(),
  createdAt: z.string(),
  approvedByRole: z.string().nullable(),
  approvedAt: z.string().nullable(),
  supersededAt: z.string().nullable(),
  rows: z.array(radSchema),
})
export type FortnoxAccountMappingRevision = z.infer<typeof revisionSchema>

const oversiktSchema = z.object({
  behov: z.array(
    z.object({
      role: roll,
      vatTreatment: behandling,
      sourceAccountNumber: z.number().int(),
      sourceAccountName: z.string(),
      varfor: z.string(),
    }),
  ),
  ejStodda: z.array(z.string()),
  revisioner: z.array(revisionSchema),
})
export type FortnoxAccountMappingOverview = z.infer<typeof oversiktSchema>

export async function getFortnoxAccountMapping(): Promise<FortnoxAccountMappingOverview> {
  return oversiktSchema.parse(await get<unknown>(PREFIX))
}

export async function createFortnoxAccountMappingDraft(
  input: FortnoxAccountMappingDraftInput,
): Promise<{ id: string; revision: number; contentSha256: string }> {
  const body: FortnoxAccountMappingDraftInput = fortnoxAccountMappingDraftInputSchema.parse(input)
  return z
    .object({ id: z.string(), revision: z.number().int(), contentSha256: z.string() })
    .parse(await post<unknown>(`${PREFIX}/revisions`, body))
}

export async function approveFortnoxAccountMapping(
  id: string,
  input: FortnoxAccountMappingApproveInput,
): Promise<void> {
  const body: FortnoxAccountMappingApproveInput =
    fortnoxAccountMappingApproveInputSchema.parse(input)
  await post<unknown>(`${PREFIX}/revisions/${encodeURIComponent(id)}/approve`, body)
}
