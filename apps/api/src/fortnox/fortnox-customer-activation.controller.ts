import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common'
import type { JwtPayload } from '@eken/shared'
import { OrgId } from '../common/decorators/org-id.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { FortnoxCustomerActivationService } from './fortnox-customer-activation.service'
import { ApproveCustomerActivationDto } from './dto/customer-activation.dto'

/** KUNDSTART-001 §6: kundaktivering. Läsa: OWNER, ADMIN, ACCOUNTANT. Besluta: bara OWNER. */
@Controller('integrations/fortnox/customer-activation')
export class FortnoxCustomerActivationController {
  constructor(private readonly svc: FortnoxCustomerActivationService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  status(@OrgId() orgId: string, @Query('financialYearId') fy?: string) {
    if (fy !== undefined && !/^\d{1,9}$/.test(fy))
      throw new BadRequestException('Ogiltigt räkenskapsår')
    return this.svc.status(orgId, fy === undefined ? null : Number(fy))
  }

  @Post('approve')
  @HttpCode(HttpStatus.OK)
  @Roles('OWNER')
  approve(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: ApproveCustomerActivationDto,
  ) {
    return this.svc.approve(orgId, { sub: user.sub, role: user.role }, dto)
  }

  @Post('revoke')
  @HttpCode(HttpStatus.OK)
  @Roles('OWNER')
  revoke(@OrgId() orgId: string, @CurrentUser() user: JwtPayload) {
    return this.svc.revoke(orgId, { sub: user.sub, role: user.role })
  }
}
