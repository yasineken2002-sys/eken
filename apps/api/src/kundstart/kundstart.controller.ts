import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common'
import type { JwtPayload } from '@eken/shared'
import { OrgId } from '../common/decorators/org-id.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { CutoverService } from './cutover.service'
import { OpeningPackageService } from './opening-package.service'
import {
  ApproveOpeningPackageDto,
  BindReadDto,
  FirstPeriodRegisterDto,
  SeparateLedgerDto,
  SetCutoverDto,
  UploadOpeningPackageDto,
} from './dto/kundstart.dto'

/**
 * KUNDSTART-001: brytdatum och öppningspaket. Rollerna står både här (första lagret) och
 * i tjänsten (bärande spärren): läsa = OWNER, ADMIN, ACCOUNTANT; ladda upp/validera/binda
 * läsning/separat reskontra/kassera = OWNER, ADMIN; brytdatum, godkänna och verkställa =
 * bara OWNER.
 */
@Controller('kundstart')
export class KundstartController {
  constructor(
    private readonly cutover: CutoverService,
    private readonly paket: OpeningPackageService,
  ) {}

  private u(user: JwtPayload) {
    return {
      sub: user.sub,
      role: user.role as 'OWNER' | 'ADMIN' | 'MANAGER' | 'ACCOUNTANT' | 'VIEWER',
    }
  }

  @Get('cutover')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT', 'MANAGER')
  getCutover(@OrgId() orgId: string) {
    return this.cutover.get(orgId)
  }

  @Put('cutover')
  @Roles('OWNER')
  setCutover(@OrgId() orgId: string, @CurrentUser() user: JwtPayload, @Body() dto: SetCutoverDto) {
    return this.cutover.set(orgId, this.u(user), dto.cutoverDate)
  }

  @Get('opening-packages')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  list(@OrgId() orgId: string) {
    return this.paket.list(orgId)
  }

  @Get('opening-packages/:id')
  @Roles('OWNER', 'ADMIN', 'ACCOUNTANT')
  get(@OrgId() orgId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.paket.get(orgId, id)
  }

  @Post('opening-packages')
  @Roles('OWNER', 'ADMIN')
  create(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UploadOpeningPackageDto,
  ) {
    return this.paket.create(orgId, this.u(user), dto)
  }

  @Put('opening-packages/:id/source')
  @Roles('OWNER', 'ADMIN')
  replace(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UploadOpeningPackageDto,
  ) {
    return this.paket.replaceSource(orgId, id, this.u(user), dto)
  }

  @Post('opening-packages/:id/validate')
  @HttpCode(HttpStatus.OK)
  @Roles('OWNER', 'ADMIN')
  validate(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.paket.validate(orgId, id, this.u(user))
  }

  @Post('opening-packages/:id/fortnox-read')
  @HttpCode(HttpStatus.OK)
  @Roles('OWNER', 'ADMIN')
  bindRead(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: BindReadDto,
  ) {
    return this.paket.bindFortnoxRead(orgId, id, this.u(user), dto.readRunId)
  }

  @Put('opening-packages/:id/separate-ledger')
  @Roles('OWNER', 'ADMIN')
  separateLedger(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SeparateLedgerDto,
  ) {
    return this.paket.setSeparateLedger(orgId, id, this.u(user), dto)
  }

  @Put('opening-packages/:id/first-period-register')
  @Roles('OWNER', 'ADMIN')
  firstPeriod(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FirstPeriodRegisterDto,
  ) {
    return this.paket.setFirstPeriodRegister(orgId, id, this.u(user), dto)
  }

  @Post('opening-packages/:id/approve')
  @HttpCode(HttpStatus.OK)
  @Roles('OWNER')
  approve(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveOpeningPackageDto,
  ) {
    return this.paket.approve(orgId, id, this.u(user), dto)
  }

  @Post('opening-packages/:id/execute')
  @HttpCode(HttpStatus.OK)
  @Roles('OWNER')
  execute(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.paket.execute(orgId, id, this.u(user))
  }

  @Post('opening-packages/:id/discard')
  @HttpCode(HttpStatus.OK)
  @Roles('OWNER', 'ADMIN')
  discard(
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.paket.discard(orgId, id, this.u(user))
  }
}
