import { Controller, Get, Post, Param, Query, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { AccountingService } from './accounting.service'

@Controller('accounting')
@UseGuards(JwtAuthGuard)
export class AccountingController {
  constructor(private readonly accountingService: AccountingService) {}

  @Get('accounts')
  async getAccounts(@OrgId() organizationId: string) {
    return this.accountingService.getAccounts(organizationId)
  }

  @Post('accounts/seed')
  async seedAccounts(@OrgId() organizationId: string) {
    await this.accountingService.seedDefaultAccounts(organizationId)
    return { message: 'Standardkonton skapade' }
  }

  @Get('journal')
  async getJournal(
    @OrgId() organizationId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('source') source?: string,
  ) {
    return this.accountingService.getJournalEntries(organizationId, {
      ...(from != null ? { from } : {}),
      ...(to != null ? { to } : {}),
      ...(source != null ? { source } : {}),
    })
  }

  @Get('journal/:id')
  async getJournalEntry(@Param('id') id: string, @OrgId() organizationId: string) {
    return this.accountingService.getJournalEntry(id, organizationId)
  }
}
