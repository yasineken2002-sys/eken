import { Module } from '@nestjs/common'
import { KundstartController } from './kundstart.controller'
import { CutoverService } from './cutover.service'
import { OpeningPackageService } from './opening-package.service'
import { OpeningEvidenceService } from './opening-evidence.service'

/** KUNDSTART-001: brytdatum och öppningspaket. Kundaktiveringen bor i FortnoxModule. */
@Module({
  controllers: [KundstartController],
  providers: [CutoverService, OpeningPackageService, OpeningEvidenceService],
  exports: [CutoverService, OpeningPackageService],
})
export class KundstartModule {}
