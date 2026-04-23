import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common'
import { OrgId } from '../common/decorators/org-id.decorator'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import type { JwtPayload } from '@eken/shared'
import { NewsService, CreateNewsPostDto, UpdateNewsPostDto } from './news.service'

@Controller('news')
export class NewsController {
  constructor(private readonly newsService: NewsService) {}

  @Get()
  async findAll(@OrgId() organizationId: string, @Query('published') published?: string) {
    const publishedFilter = published === 'true' ? true : published === 'false' ? false : undefined
    return this.newsService.findAll(organizationId, publishedFilter)
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @OrgId() organizationId: string) {
    return this.newsService.findOne(id, organizationId)
  }

  @Post()
  async create(
    @OrgId() organizationId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateNewsPostDto,
  ) {
    return this.newsService.create(dto, organizationId, user.sub)
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @OrgId() organizationId: string,
    @Body() dto: UpdateNewsPostDto,
  ) {
    return this.newsService.update(id, dto, organizationId)
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  async publish(@Param('id') id: string, @OrgId() organizationId: string) {
    return this.newsService.publish(id, organizationId)
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @OrgId() organizationId: string): Promise<void> {
    await this.newsService.remove(id, organizationId)
  }
}
