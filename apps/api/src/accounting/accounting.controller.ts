import { Controller, Get, Post, Param, Query, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard'
import { OrgId } from '../common/decorators/org-id.decorator'
import { Roles } from '../common/decorators/roles.decorator'
import { AccountingService } from './accounting.service'

// C1: hela bokföringen kräver minst ACCOUNTANT — konsekvent med accounts/seed
// och collections (ekonomidomänen = ACCOUNTANT och uppåt). Utan detta kunde
// VIEWER läsa hela verifikationsjournalen. Klass-nivå täcker alla GET-routes;
// hierarkisk RolesGuard släpper in ACCOUNTANT/MANAGER/ADMIN/OWNER, ej VIEWER.
@Controller('accounting')
@UseGuards(JwtAuthGuard)
@Roles('ACCOUNTANT', 'MANAGER', 'ADMIN', 'OWNER')
export class AccountingController {
  constructor(private readonly accountingService: AccountingService) {}

  @Get('accounts')
  async getAccounts(@OrgId() organizationId: string) {
    return this.accountingService.getAccounts(organizationId)
  }

  @Post('accounts/seed')
  @Roles('ACCOUNTANT', 'MANAGER', 'ADMIN', 'OWNER')
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
