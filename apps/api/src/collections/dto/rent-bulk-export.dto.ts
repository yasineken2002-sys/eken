import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator'

export class RentBulkExportDto {
  @IsArray()
  // Tak mot resursuttömning (säkerhetsgranskning LOW): N avier ⇒ N Puppeteer-
  // renderingar i ett jobb. 200 inkasso-redo avier i en batch är redan extremt.
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  noticeIds!: string[]
}
