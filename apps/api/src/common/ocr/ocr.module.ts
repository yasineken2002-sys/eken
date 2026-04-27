import { Global, Module } from '@nestjs/common'
import { PrismaModule } from '../prisma/prisma.module'
import { OcrService } from './ocr.service'

@Global()
@Module({
  imports: [PrismaModule],
  providers: [OcrService],
  exports: [OcrService],
})
export class OcrModule {}
