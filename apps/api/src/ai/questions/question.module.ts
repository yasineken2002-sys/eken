import { Module } from '@nestjs/common'

import { PrismaModule } from '../../common/prisma/prisma.module'
import { QuestionService } from './question.service'

/**
 * AGENTENS FRÅGOR (etapp 8 PR 5b).
 *
 * Modulen importerar inte verktygsexekveraren och skriver ingen effekt utöver
 * en minnespost — ett svar ÄR data, inte en handling.
 */
@Module({
  imports: [PrismaModule],
  providers: [QuestionService],
  exports: [QuestionService],
})
export class QuestionModule {}
