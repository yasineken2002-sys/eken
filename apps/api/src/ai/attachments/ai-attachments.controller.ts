import {
  BadRequestException,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common'
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger'
import { Throttle } from '@nestjs/throttler'
import type { FastifyRequest } from 'fastify'
import { AiAttachmentsService } from './ai-attachments.service'
import { CurrentUser } from '../../common/decorators/current-user.decorator'
import { OrgId } from '../../common/decorators/org-id.decorator'
import { Roles } from '../../common/decorators/roles.decorator'
import type { JwtPayload } from '@eken/shared'

/**
 * SPÅR B1 — bilagor till AI-chatten.
 *
 * Samma rollgrind som `AiAssistantController`: bilagor är en del av chatten,
 * och den kräver minst ACCOUNTANT. Endpointen ligger i en egen controller för
 * att den är multipart (`request.parts()`) medan chatt-controllern är JSON.
 *
 * Rör INTE chatt-vägen. Det som laddas upp här når ingen modell förrän B2.
 */
@ApiTags('AI')
@ApiBearerAuth()
@Controller('ai/attachments')
@Roles('ACCOUNTANT', 'MANAGER', 'ADMIN', 'OWNER')
export class AiAttachmentsController {
  constructor(private readonly service: AiAttachmentsService) {}

  @Post()
  // Lägre tak än chatten (30/min): en uppladdning kostar bandbredd och lagring,
  // och ett normalt meddelande bär enstaka bilagor, inte tiotals.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Ladda upp en bilaga till AI-chatten (multipart/form-data)' })
  @ApiConsumes('multipart/form-data')
  async upload(
    @Req() request: FastifyRequest,
    @OrgId() orgId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const parts = request.parts()

    let fileBuffer: Buffer | null = null
    let filename = ''
    const fields: Record<string, string> = {}

    for await (const part of parts) {
      if (part.type === 'file') {
        // En fil per anrop. Flera bilagor blir flera anrop — det gör att en
        // enskild avvisad fil inte river hela uppladdningen, och att UI:t kan
        // visa status per fil.
        if (fileBuffer) {
          throw new BadRequestException('Ladda upp en fil i taget')
        }
        fileBuffer = await part.toBuffer()
        filename = part.filename
      } else {
        fields[part.fieldname] = part.value as string
      }
    }

    if (!fileBuffer || !filename) {
      throw new BadRequestException('Ingen fil hittades i formuläret')
    }

    return this.service.upload(
      { buffer: fileBuffer, filename },
      orgId,
      user.sub,
      fields['conversationId'],
    )
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Ta bort en bilaga som ännu inte skickats' })
  remove(@Param('id') id: string, @OrgId() orgId: string, @CurrentUser() user: JwtPayload) {
    return this.service.remove(id, orgId, user.sub)
  }
}
