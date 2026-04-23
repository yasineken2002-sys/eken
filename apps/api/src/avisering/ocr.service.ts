import { Injectable } from '@nestjs/common'
import { PrismaService } from '../common/prisma/prisma.service'

@Injectable()
export class OcrService {
  constructor(private readonly prisma: PrismaService) {}

  private luhnChecksum(digits: string): number {
    let sum = 0
    let alternate = false
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = parseInt(digits[i] ?? '0', 10)
      if (alternate) {
        n *= 2
        if (n > 9) n -= 9
      }
      sum += n
      alternate = !alternate
    }
    return (10 - (sum % 10)) % 10
  }

  generateOcrNumber(orgPrefix: number, tenantSequence: number): string {
    const base = `${String(orgPrefix).padStart(4, '0')}${String(tenantSequence).padStart(6, '0')}`
    const check = this.luhnChecksum(base)
    return `${base}${check}`
  }

  validateOcrNumber(ocr: string): boolean {
    if (!/^\d{11}$/.test(ocr)) return false
    const base = ocr.slice(0, -1)
    const check = parseInt(ocr.slice(-1), 10)
    return this.luhnChecksum(base) === check
  }

  private orgPrefix(organizationId: string): number {
    const hex = organizationId.replace(/-/g, '').slice(0, 4) || '1000'
    return (parseInt(hex, 16) % 9000) + 1000
  }

  async assignOcrToTenant(tenantId: string, orgId: string): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } })
    if (tenant?.ocrNumber) return tenant.ocrNumber

    const count = await this.prisma.tenant.count({
      where: { organizationId: orgId, ocrNumber: { not: null } },
    })
    const prefix = this.orgPrefix(orgId)
    const ocr = this.generateOcrNumber(prefix, count + 1)

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { ocrNumber: ocr },
    })
    return ocr
  }
}
