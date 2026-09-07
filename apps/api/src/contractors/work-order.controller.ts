import { Body, Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'

import { WorkOrderService } from './work-order.service'
import { CancelWorkOrderDto, SendWorkOrderDto, WorkOrderResponseDto } from './dto/work-order.dto'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { Public } from '../common/decorators/public.decorator'
import type { JwtPayload } from '@eken/shared'

/**
 * ATT BOKA ÄR EN UTÅTRIKTAD HANDLING — förvaltningsgränsen, som att tilldela.
 * En bokförare eller VIEWER ska inte kunna skicka ett mejl i organisationens
 * namn till en utomstående.
 */
@Controller('maintenance')
@UseGuards(JwtAuthGuard)
export class WorkOrderController {
  constructor(private readonly workOrders: WorkOrderService) {}

  @Post(':id/work-orders')
  @Roles('OWNER', 'ADMIN', 'MANAGER')
  send(
    @Param('id') ticketId: string,
    @Body() dto: SendWorkOrderDto,
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.workOrders.send(ticketId, dto, orgId, user.sub)
  }
}

@Controller('work-orders')
@UseGuards(JwtAuthGuard)
export class WorkOrderAdminController {
  constructor(private readonly workOrders: WorkOrderService) {}

  @Post(':id/cancel')
  @Roles('OWNER', 'ADMIN', 'MANAGER')
  cancel(@Param('id') id: string, @Body() dto: CancelWorkOrderDto, @OrgId() orgId: string) {
    return this.workOrders.cancel(id, orgId, dto.skal)
  }
}

/**
 * HANTVERKARENS SVARSVÄG — publik, för hantverkaren har ingen inloggning.
 *
 * `@Public()` gäller BARA den här controllern, och grinden är inte dekoratorn
 * utan token: hashat uppslag, engångs, kortlivat, och utan behörighet att göra
 * något annat än att svara på just den ordern. Samma konstruktion som
 * portalens aktiveringslänk.
 *
 * STRYPNINGEN är en del av spärren. Utan den är en publik endpoint som slår upp
 * på ett hemligt värde en gissningsyta — 32 slumpade bytes går inte att gissa,
 * men taket gör försöket meningslöst i stället för bara osannolikt.
 */
@Controller('work-orders')
@Public()
export class WorkOrderPublicController {
  constructor(private readonly workOrders: WorkOrderService) {}

  @Post(':token/respond')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  respond(@Param('token') token: string, @Body() dto: WorkOrderResponseDto) {
    return this.workOrders.respond(token, dto)
  }
}
