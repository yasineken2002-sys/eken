import { ConflictException } from '@nestjs/common'
import { PrismaClient } from '@prisma/client'
import type { Prisma } from '@prisma/client'
import { DeliveryDecisions } from './delivery-decisions'
import { requireChargeActor } from './charge-gate'

// Betrodd deltagarport. Äldre skrivare är inte inkopplade; callbackens deklarerade
// skrivmängd är ett kontrakt, inte en sandbox för godtycklig SQL.
export class DeliveryWrites {
  constructor(private readonly db: PrismaClient) {}

  async run<T>(
    scope: { organizationId: string; actorId: string; documentIds: string[]; chargeIds: string[] },
    write: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return new DeliveryDecisions(this.db).transaction(async (tx) => {
      await tx.$queryRaw`SELECT delivery_lock(${scope.organizationId})::text`
      await requireChargeActor(tx, scope.organizationId, scope.actorId)
      const blocked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT d."id" FROM "DeliveryDecision" d
        CROSS JOIN LATERAL (SELECT "state" FROM "DeliveryEvent"
          WHERE "decisionId" = d."id" ORDER BY "revision" DESC LIMIT 1) e
        WHERE d."organizationId" = ${scope.organizationId} AND e."state" IN ('SENDING','UNKNOWN')
        AND (d."documentId" = ANY(${scope.documentIds}::text[])
          OR EXISTS (SELECT FROM "DeliveryMember" m WHERE m."decisionId" = d."id"
            AND m."chargeId" = ANY(${scope.chargeIds}::text[]))
          OR EXISTS (SELECT FROM delivery_charge_ids(d."documentId") c
            WHERE c = ANY(${scope.chargeIds}::text[])))`
      if (blocked.length) throw new ConflictException('DELIVERY_WRITE_RESERVED')
      return write(tx)
    })
  }
}
