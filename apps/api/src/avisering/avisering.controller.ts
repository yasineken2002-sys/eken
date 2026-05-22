import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Res,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common'
import type { FastifyReply } from 'fastify'
import { AviseringService } from './avisering.service'
import { AviseringScheduler } from './avisering.scheduler'
import { GenerateNoticesDto } from './dto/generate-notices.dto'
import { SendNoticesDto } from './dto/send-notices.dto'
import { MarkPaidDto } from './dto/mark-paid.dto'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { UserRole } from '@prisma/client'
import type { RentNoticeStatus } from '@prisma/client'

@Controller('avisering')
export class AviseringController {
  constructor(
    private readonly aviseringService: AviseringService,
    private readonly scheduler: AviseringScheduler,
  ) {}

  @Post('generate')
  @Roles(UserRole.MANAGER, UserRole.ADMIN, UserRole.OWNER)
  async generate(@OrgId() orgId: string, @Body() dto: GenerateNoticesDto) {
    return this.aviseringService.generateMonthlyNotices(orgId, dto.month, dto.year)
  }

  // Admin-trigger för månadscronen. Använd för att simulera "1:a varje månad
  // kl 07:00" i test eller om servern var nere när cron skulle köra.
  @Post('cron/run/:year/:month')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  async runCron(
    @Param('year', ParseIntPipe) year: number,
    @Param('month', ParseIntPipe) month: number,
  ) {
    return this.scheduler.runForMonth(year, month)
  }

  @Post('send')
  @Roles(UserRole.MANAGER, UserRole.ADMIN, UserRole.OWNER)
  @HttpCode(HttpStatus.ACCEPTED)
  async send(@OrgId() orgId: string, @Body() dto: SendNoticesDto) {
    return this.aviseringService.sendNotices(orgId, dto.noticeIds)
  }

  @Post('send-all/:month/:year')
  @Roles(UserRole.MANAGER, UserRole.ADMIN, UserRole.OWNER)
  @HttpCode(HttpStatus.ACCEPTED)
  async sendAll(
    @OrgId() orgId: string,
    @Param('month', ParseIntPipe) month: number,
    @Param('year', ParseIntPipe) year: number,
  ) {
    const notices = await this.aviseringService.findAll(orgId, {
      month,
      year,
      status: 'PENDING' as RentNoticeStatus,
    })
    const ids = notices.map((n) => n.id)
    return this.aviseringService.sendNotices(orgId, ids)
  }

  @Get('stats/:month/:year')
  async stats(
    @OrgId() orgId: string,
    @Param('month', ParseIntPipe) month: number,
    @Param('year', ParseIntPipe) year: number,
  ) {
    return this.aviseringService.getStats(orgId, month, year)
  }

  @Get()
  async findAll(
    @OrgId() orgId: string,
    @Query('month') month?: string,
    @Query('year') year?: string,
    @Query('status') status?: string,
  ) {
    return this.aviseringService.findAll(orgId, {
      ...(month ? { month: parseInt(month, 10) } : {}),
      ...(year ? { year: parseInt(year, 10) } : {}),
      ...(status ? { status: status as RentNoticeStatus } : {}),
    })
  }

  @Get(':id/pdf')
  async pdf(@OrgId() orgId: string, @Param('id') id: string, @Res() reply: FastifyReply) {
    const buffer = await this.aviseringService.getNoticePdfBuffer(id, orgId)
    void reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="hyresavi.pdf"`)
      .send(buffer)
  }

  @Get(':id')
  async findOne(@OrgId() orgId: string, @Param('id') id: string) {
    return this.aviseringService.findOne(id, orgId)
  }

  @Patch(':id/paid')
  @Roles(UserRole.MANAGER, UserRole.ADMIN, UserRole.OWNER)
  async markPaid(@OrgId() orgId: string, @Param('id') id: string, @Body() dto: MarkPaidDto) {
    return this.aviseringService.markAsPaid(id, orgId, dto.paidAmount, dto.paidAt)
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN, UserRole.OWNER)
  @HttpCode(HttpStatus.OK)
  async cancel(@OrgId() orgId: string, @Param('id') id: string) {
    return this.aviseringService.cancelNotice(id, orgId)
  }
}
