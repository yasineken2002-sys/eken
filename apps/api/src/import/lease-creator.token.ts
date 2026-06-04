import { CreateLeaseWithTenantDto } from '../leases/dto/create-lease-with-tenant.dto'

/**
 * Smal DI-söm mot avtalsskapandet. ContractScanBatchService beror på detta
 * INTERFACE (inte direkt på LeasesService) så att tjänstens modulgraf inte drar
 * in hela leases→pdf→storage→aws-sdk-kedjan (som annars bryter ts-jest på en
 * ESM-only transitiv dep). ImportModule binder token → LeasesService med
 * `useExisting`, så runtime får den riktiga implementationen.
 */
export const LEASE_CREATOR = Symbol('CONTRACT_BATCH_LEASE_CREATOR')

export interface LeaseCreator {
  createWithTenant(
    dto: CreateLeaseWithTenantDto,
    organizationId: string,
    actorUserId?: string | null,
  ): Promise<{ id: string }>
}
