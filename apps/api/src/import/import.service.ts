import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as XLSX from 'xlsx'
import { PrismaService } from '../common/prisma/prisma.service'
import type { Prisma } from '@prisma/client'
import { ImportJobStatus, ImportJobType } from '@prisma/client'

type InputJsonValue = Prisma.InputJsonValue

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParsedRow {
  rowNumber: number
  data: Record<string, string>
}

export interface ImportError {
  row: number
  message: string
}

export interface ImportResult {
  successRows: number
  errorRows: number
  errors: ImportError[]
}

export interface PreviewResult {
  type: string
  filename: string
  totalRows: number
  validRows: number
  errorRows: number
  headers: string[]
  detectedMappings: Record<string, string>
  preview: Record<string, string>[]
  errors: ImportError[]
}

// ─── Header Mappings ──────────────────────────────────────────────────────────

const HEADER_MAP: Record<string, string[]> = {
  name: ['namn', 'name', 'fastighetsnamn'],
  propertyDesignation: ['beteckning', 'fastighetsbeteckning', 'property designation'],
  type: ['typ', 'type'],
  street: ['gata', 'gatuadress', 'adress', 'street', 'address'],
  city: ['stad', 'city', 'ort'],
  postalCode: ['postnummer', 'postal code', 'zip', 'postkod'],
  totalArea: ['yta', 'area', 'm2', 'm²', 'total area', 'totalyta'],
  yearBuilt: ['byggår', 'year built', 'byggnadsar'],
  unitNumber: ['enhetsnummer', 'unit number', 'nummer', 'nr', 'lägenhetsnummer'],
  monthlyRent: ['hyra', 'månadshyra', 'monthly rent', 'rent', 'hyresnivå'],
  floor: ['våning', 'floor', 'plan'],
  rooms: ['rum', 'rooms', 'antal rum'],
  firstName: ['förnamn', 'first name', 'fornamn'],
  lastName: ['efternamn', 'last name', 'efternamn', 'surname'],
  companyName: ['företagsnamn', 'company', 'bolag', 'company name', 'foretagsnamn'],
  email: ['e-post', 'email', 'epost', 'mail', 'e-mail'],
  phone: ['telefon', 'phone', 'tel', 'mobil', 'mobilnummer'],
  personalNumber: ['personnummer', 'personal number', 'personnr'],
  orgNumber: ['organisationsnummer', 'org number', 'orgnr', 'org.nummer'],
  startDate: ['startdatum', 'start date', 'från', 'inflyttning', 'start'],
  endDate: ['slutdatum', 'end date', 'till', 'utflyttning', 'slut'],
  depositAmount: ['deposition', 'deposit', 'depositionsbelopp'],
  tenantEmail: ['hyresgäst e-post', 'tenant email', 'hyresgast e-post', 'hyresgäst epost'],
  propertyName: ['fastighet', 'property', 'fastighetens namn'],
  status: ['status'],
  unitType: ['enhetstyp', 'unit type', 'lokal typ'],
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class ImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  // ─── File Parsing ──────────────────────────────────────────────────────────

  parseFile(buffer: Buffer, filename: string): ParsedRow[] {
    const ext = filename.toLowerCase().split('.').pop() ?? ''

    if (ext === 'csv') {
      return this.parseCsv(buffer)
    } else if (['xlsx', 'xls'].includes(ext)) {
      return this.parseExcel(buffer)
    }
    throw new Error(`Filformatet stöds inte: .${ext}`)
  }

  private parseCsv(buffer: Buffer): ParsedRow[] {
    const text = buffer.toString('utf-8').replace(/^\uFEFF/, '') // strip BOM
    const lines = text.split(/\r?\n/)
    if (lines.length < 2) return []

    // Auto-detect delimiter
    const firstLine = lines[0] ?? ''
    const delimiter =
      (firstLine.match(/;/g) ?? []).length > (firstLine.match(/,/g) ?? []).length ? ';' : ','

    const headers = this.splitCsvLine(firstLine, delimiter).map((h) => h.trim())
    const rows: ParsedRow[] = []

    for (let i = 1; i < lines.length; i++) {
      const line = (lines[i] ?? '').trim()
      if (!line) continue

      const values = this.splitCsvLine(line, delimiter)
      const data: Record<string, string> = {}
      headers.forEach((header, idx) => {
        data[header] = (values[idx] ?? '').trim()
      })

      // Skip rows where all values are empty
      if (Object.values(data).every((v) => !v)) continue

      rows.push({ rowNumber: i + 1, data })
    }

    return rows
  }

  private splitCsvLine(line: string, delimiter: string): string[] {
    const result: string[] = []
    let current = ''
    let inQuotes = false

    for (let i = 0; i < line.length; i++) {
      const char = line[i]
      if (char === '"') {
        inQuotes = !inQuotes
      } else if (char === delimiter && !inQuotes) {
        result.push(current)
        current = ''
      } else {
        current += char
      }
    }
    result.push(current)
    return result
  }

  private parseExcel(buffer: Buffer): ParsedRow[] {
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true })
    const sheetName = workbook.SheetNames[0]
    if (!sheetName) return []

    const sheet = workbook.Sheets[sheetName]
    if (!sheet) return []

    const data = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      defval: '',
      blankrows: false,
    })

    if (data.length < 2) return []

    const firstDataRow = data[0]
    const headers = Array.isArray(firstDataRow)
      ? (firstDataRow as unknown[]).map((h) => String(h ?? '').trim())
      : []
    const rows: ParsedRow[] = []

    for (let i = 1; i < data.length; i++) {
      const rawRow = data[i]
      const values: unknown[] = Array.isArray(rawRow) ? rawRow : []
      const rowData: Record<string, string> = {}
      headers.forEach((header, idx) => {
        const val = values[idx]
        rowData[header] = val instanceof Date ? this.formatDateToISO(val) : String(val ?? '').trim()
      })

      if (Object.values(rowData).every((v) => !v)) continue

      rows.push({ rowNumber: i + 1, data: rowData })
    }

    return rows
  }

  // ─── Header Normalization ──────────────────────────────────────────────────

  normalizeHeaders(headers: string[]): Record<string, string> {
    const mapping: Record<string, string> = {}

    for (const header of headers) {
      const normalizedHeader = header.toLowerCase().trim()

      for (const [standardKey, variants] of Object.entries(HEADER_MAP)) {
        if (variants.some((v) => normalizedHeader === v || normalizedHeader.includes(v))) {
          mapping[header] = standardKey
          break
        }
      }
    }

    return mapping
  }

  normalizeRow(
    rawData: Record<string, string>,
    headerMapping: Record<string, string>,
  ): Record<string, string> {
    const normalized: Record<string, string> = {}

    for (const [rawHeader, value] of Object.entries(rawData)) {
      const standardKey = headerMapping[rawHeader]
      if (standardKey) {
        normalized[standardKey] = value
      } else {
        normalized[rawHeader] = value
      }
    }

    return normalized
  }

  // ─── Validation ────────────────────────────────────────────────────────────

  validatePropertyRow(row: Record<string, string>): string[] {
    const errors: string[] = []
    if (!row['name']) errors.push('Namn saknas')
    if (!row['propertyDesignation']) errors.push('Fastighetsbeteckning saknas')
    if (!row['street']) errors.push('Gatuadress saknas')
    if (!row['city']) errors.push('Stad saknas')
    if (!row['postalCode']) errors.push('Postnummer saknas')
    return errors
  }

  validateUnitRow(row: Record<string, string>): string[] {
    const errors: string[] = []
    if (!row['name']) errors.push('Enhetsnamn saknas')
    if (!row['unitNumber']) errors.push('Enhetsnummer saknas')
    if (!row['monthlyRent']) {
      errors.push('Månadshyra saknas')
    } else if (this.parseAmount(row['monthlyRent']) === null) {
      errors.push('Månadshyra är inte ett giltigt belopp')
    }
    return errors
  }

  validateTenantRow(row: Record<string, string>): string[] {
    const errors: string[] = []
    if (!row['email']) {
      errors.push('E-post saknas')
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row['email'])) {
      errors.push('E-postadressen har ogiltigt format')
    }

    const type = row['type']?.toUpperCase() ?? 'INDIVIDUAL'
    if (type === 'COMPANY' || row['companyName']) {
      if (!row['companyName']) errors.push('Företagsnamn krävs för företagshyresgäster')
    } else {
      if (!row['firstName']) errors.push('Förnamn saknas')
      if (!row['lastName']) errors.push('Efternamn saknas')
    }

    return errors
  }

  validateLeaseRow(row: Record<string, string>): string[] {
    const errors: string[] = []
    if (!row['startDate']) {
      errors.push('Startdatum saknas')
    } else if (!this.parseDate(row['startDate'])) {
      errors.push('Startdatum har ogiltigt format (använd YYYY-MM-DD)')
    }
    if (row['endDate'] && !this.parseDate(row['endDate'])) {
      errors.push('Slutdatum har ogiltigt format (använd YYYY-MM-DD)')
    }
    if (!row['monthlyRent']) {
      errors.push('Månadshyra saknas')
    } else if (this.parseAmount(row['monthlyRent']) === null) {
      errors.push('Månadshyra är inte ett giltigt belopp')
    }
    return errors
  }

  // ─── Import Executors ──────────────────────────────────────────────────────

  async importProperties(
    rows: ParsedRow[],
    organizationId: string,
    jobId: string,
  ): Promise<ImportResult> {
    let successRows = 0
    let errorRows = 0
    const errors: ImportError[] = []

    for (const { rowNumber, data } of rows) {
      try {
        const validationErrors = this.validatePropertyRow(data)
        if (validationErrors.length > 0) {
          errors.push({ row: rowNumber, message: validationErrors.join(', ') })
          errorRows++
          continue
        }

        // Duplicate check
        const existing = await this.prisma.property.findFirst({
          where: {
            organizationId,
            propertyDesignation: data['propertyDesignation'] ?? '',
          },
        })
        if (existing) {
          errors.push({
            row: rowNumber,
            message: `Fastighet med beteckning "${data['propertyDesignation']}" finns redan`,
          })
          errorRows++
          continue
        }

        await this.prisma.property.create({
          data: {
            organizationId,
            name: data['name'] ?? '',
            propertyDesignation: data['propertyDesignation'] ?? '',
            type: (this.parsePropertyType(data['type'] ?? '') ?? 'RESIDENTIAL') as
              | 'RESIDENTIAL'
              | 'COMMERCIAL'
              | 'MIXED'
              | 'INDUSTRIAL'
              | 'LAND',
            street: data['street'] ?? '',
            city: data['city'] ?? '',
            postalCode: data['postalCode'] ?? '',
            country: 'SE',
            totalArea: this.parseAmount(data['totalArea'] ?? '') ?? 0,
            yearBuilt: data['yearBuilt'] ? parseInt(data['yearBuilt'], 10) || null : null,
          },
        })

        successRows++
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Okänt fel'
        errors.push({ row: rowNumber, message: `Databasfel: ${msg}` })
        errorRows++
      }

      await this.prisma.importJob.update({
        where: { id: jobId },
        data: { processedRows: { increment: 1 }, successRows, errorRows },
      })
    }

    return { successRows, errorRows, errors }
  }

  async importUnits(
    rows: ParsedRow[],
    organizationId: string,
    jobId: string,
  ): Promise<ImportResult> {
    let successRows = 0
    let errorRows = 0
    const errors: ImportError[] = []

    // Pre-fetch all properties for this org
    const properties = await this.prisma.property.findMany({
      where: { organizationId },
      select: { id: true, name: true },
    })

    for (const { rowNumber, data } of rows) {
      try {
        const validationErrors = this.validateUnitRow(data)
        if (validationErrors.length > 0) {
          errors.push({ row: rowNumber, message: validationErrors.join(', ') })
          errorRows++
          continue
        }

        // Find property by name (case-insensitive fuzzy)
        const propertyName = data['propertyName'] ?? data['name'] ?? ''
        let property = properties.find((p) => p.name.toLowerCase() === propertyName.toLowerCase())
        if (!property) {
          property = properties.find((p) =>
            p.name.toLowerCase().includes(propertyName.toLowerCase()),
          )
        }

        if (!property && properties.length === 1) {
          // If only one property, assign to it automatically
          property = properties[0]
        }

        if (!property) {
          errors.push({
            row: rowNumber,
            message: `Fastighet "${propertyName}" hittades inte`,
          })
          errorRows++
          continue
        }

        // Duplicate check: unitNumber + propertyId
        const existing = await this.prisma.unit.findFirst({
          where: { propertyId: property.id, unitNumber: data['unitNumber'] ?? '' },
        })
        if (existing) {
          errors.push({
            row: rowNumber,
            message: `Enhet "${data['unitNumber']}" finns redan i fastigheten`,
          })
          errorRows++
          continue
        }

        await this.prisma.unit.create({
          data: {
            propertyId: property.id,
            name: data['name'] ?? data['unitNumber'] ?? '',
            unitNumber: data['unitNumber'] ?? '',
            type: (this.parseUnitType(data['type'] ?? data['unitType'] ?? '') ?? 'APARTMENT') as
              | 'APARTMENT'
              | 'OFFICE'
              | 'RETAIL'
              | 'STORAGE'
              | 'PARKING'
              | 'OTHER',
            status: 'VACANT',
            area: this.parseAmount(data['totalArea'] ?? data['area'] ?? '') ?? 0,
            floor: data['floor'] ? parseInt(data['floor'], 10) || null : null,
            rooms: data['rooms'] ? parseInt(data['rooms'], 10) || null : null,
            monthlyRent: this.parseAmount(data['monthlyRent'] ?? '') ?? 0,
          },
        })

        successRows++
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Okänt fel'
        errors.push({ row: rowNumber, message: `Databasfel: ${msg}` })
        errorRows++
      }

      await this.prisma.importJob.update({
        where: { id: jobId },
        data: { processedRows: { increment: 1 }, successRows, errorRows },
      })
    }

    return { successRows, errorRows, errors }
  }

  async importTenants(
    rows: ParsedRow[],
    organizationId: string,
    jobId: string,
  ): Promise<ImportResult> {
    let successRows = 0
    let errorRows = 0
    const errors: ImportError[] = []

    for (const { rowNumber, data } of rows) {
      try {
        const validationErrors = this.validateTenantRow(data)
        if (validationErrors.length > 0) {
          errors.push({ row: rowNumber, message: validationErrors.join(', ') })
          errorRows++
          continue
        }

        // Duplicate check: email + organizationId
        const existing = await this.prisma.tenant.findFirst({
          where: { organizationId, email: data['email'] ?? '' },
        })
        if (existing) {
          errors.push({
            row: rowNumber,
            message: `Hyresgäst med e-post "${data['email']}" finns redan`,
          })
          errorRows++
          continue
        }

        // Infer type from data if missing
        const rawType = data['type']?.toUpperCase() ?? ''
        let tenantType: 'INDIVIDUAL' | 'COMPANY' = 'INDIVIDUAL'
        if (
          rawType === 'COMPANY' ||
          rawType === 'FÖRETAG' ||
          rawType === 'FORETAG' ||
          data['companyName']
        ) {
          tenantType = 'COMPANY'
        }

        await this.prisma.tenant.create({
          data: {
            organizationId,
            type: tenantType,
            firstName: data['firstName'] || null,
            lastName: data['lastName'] || null,
            companyName: data['companyName'] || null,
            email: data['email'] ?? '',
            phone: data['phone'] || null,
            personalNumber: data['personalNumber'] || null,
            orgNumber: data['orgNumber'] || null,
            street: data['street'] || null,
            city: data['city'] || null,
            postalCode: data['postalCode'] || null,
            country: 'SE',
          },
        })

        successRows++
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Okänt fel'
        errors.push({ row: rowNumber, message: `Databasfel: ${msg}` })
        errorRows++
      }

      await this.prisma.importJob.update({
        where: { id: jobId },
        data: { processedRows: { increment: 1 }, successRows, errorRows },
      })
    }

    return { successRows, errorRows, errors }
  }

  async importLeases(
    rows: ParsedRow[],
    organizationId: string,
    jobId: string,
  ): Promise<ImportResult> {
    let successRows = 0
    let errorRows = 0
    const errors: ImportError[] = []

    // Pre-fetch tenants and units upfront
    const tenants = await this.prisma.tenant.findMany({
      where: { organizationId },
      select: { id: true, email: true },
    })

    const units = await this.prisma.unit.findMany({
      where: { property: { organizationId } },
      select: { id: true, unitNumber: true, propertyId: true },
    })

    const today = new Date()

    for (const { rowNumber, data } of rows) {
      try {
        const validationErrors = this.validateLeaseRow(data)
        if (validationErrors.length > 0) {
          errors.push({ row: rowNumber, message: validationErrors.join(', ') })
          errorRows++
          continue
        }

        // Find tenant by email
        const tenantEmail = data['tenantEmail'] ?? data['email'] ?? ''
        const tenant = tenants.find((t) => t.email.toLowerCase() === tenantEmail.toLowerCase())
        if (!tenant) {
          errors.push({
            row: rowNumber,
            message: `Hyresgäst med e-post "${tenantEmail}" hittades inte`,
          })
          errorRows++
          continue
        }

        // Find unit by unitNumber
        const unitNumber = data['unitNumber'] ?? ''
        const unit = units.find((u) => u.unitNumber === unitNumber)
        if (!unit) {
          errors.push({
            row: rowNumber,
            message: `Enhet "${unitNumber}" hittades inte`,
          })
          errorRows++
          continue
        }

        const startDate = this.parseDate(data['startDate'] ?? '')
        const endDate = data['endDate'] ? this.parseDate(data['endDate']) : null

        if (!startDate) {
          errors.push({ row: rowNumber, message: 'Ogiltigt startdatum' })
          errorRows++
          continue
        }

        // Determine status
        let status: 'ACTIVE' | 'EXPIRED' | 'DRAFT' = 'ACTIVE'
        if (endDate && endDate < today) {
          status = 'EXPIRED'
        } else if (startDate > today) {
          status = 'DRAFT'
        }

        await this.prisma.lease.create({
          data: {
            organizationId,
            unitId: unit.id,
            tenantId: tenant.id,
            status,
            startDate,
            endDate: endDate ?? null,
            monthlyRent: this.parseAmount(data['monthlyRent'] ?? '') ?? 0,
            depositAmount: this.parseAmount(data['depositAmount'] ?? '') ?? 0,
            noticePeriodMonths: data['noticePeriodMonths']
              ? parseInt(data['noticePeriodMonths'], 10) || 3
              : 3,
          },
        })

        successRows++
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Okänt fel'
        errors.push({ row: rowNumber, message: `Databasfel: ${msg}` })
        errorRows++
      }

      await this.prisma.importJob.update({
        where: { id: jobId },
        data: { processedRows: { increment: 1 }, successRows, errorRows },
      })
    }

    return { successRows, errorRows, errors }
  }

  // ─── Preview (no DB writes) ────────────────────────────────────────────────

  previewImport(buffer: Buffer, filename: string, type: string): PreviewResult {
    const rows = this.parseFile(buffer, filename)
    if (rows.length === 0) {
      return {
        type,
        filename,
        totalRows: 0,
        validRows: 0,
        errorRows: 0,
        headers: [],
        detectedMappings: {},
        preview: [],
        errors: [],
      }
    }

    const headers = Object.keys(rows[0]?.data ?? {})
    const headerMapping = this.normalizeHeaders(headers)

    const errors: ImportError[] = []
    let validRows = 0
    let errorRows = 0

    for (const { rowNumber, data } of rows) {
      const normalized = this.normalizeRow(data, headerMapping)
      let rowErrors: string[] = []

      switch (type.toUpperCase()) {
        case 'PROPERTIES':
          rowErrors = this.validatePropertyRow(normalized)
          break
        case 'UNITS':
          rowErrors = this.validateUnitRow(normalized)
          break
        case 'TENANTS':
          rowErrors = this.validateTenantRow(normalized)
          break
        case 'LEASES':
          rowErrors = this.validateLeaseRow(normalized)
          break
      }

      if (rowErrors.length > 0) {
        errors.push({ row: rowNumber, message: rowErrors.join(', ') })
        errorRows++
      } else {
        validRows++
      }
    }

    const preview = rows.slice(0, 5).map(({ data }) => this.normalizeRow(data, headerMapping))

    return {
      type,
      filename,
      totalRows: rows.length,
      validRows,
      errorRows,
      headers,
      detectedMappings: headerMapping,
      preview,
      errors,
    }
  }

  // ─── Full Import (with DB writes) ─────────────────────────────────────────

  async processImport(
    buffer: Buffer,
    filename: string,
    type: string,
    organizationId: string,
    userId: string,
  ) {
    const jobType = type.toUpperCase() as ImportJobType

    // Create job
    const job = await this.prisma.importJob.create({
      data: {
        organizationId,
        type: jobType,
        status: ImportJobStatus.PROCESSING,
        filename,
        createdById: userId,
      },
    })

    try {
      const rows = this.parseFile(buffer, filename)
      const headers = rows.length > 0 ? Object.keys(rows[0]?.data ?? {}) : []
      const headerMapping = this.normalizeHeaders(headers)
      const normalizedRows = rows.map(({ rowNumber, data }) => ({
        rowNumber,
        data: this.normalizeRow(data, headerMapping),
      }))

      await this.prisma.importJob.update({
        where: { id: job.id },
        data: { totalRows: rows.length },
      })

      let result: ImportResult = { successRows: 0, errorRows: 0, errors: [] }

      switch (jobType) {
        case ImportJobType.PROPERTIES:
          result = await this.importProperties(normalizedRows, organizationId, job.id)
          break
        case ImportJobType.UNITS:
          result = await this.importUnits(normalizedRows, organizationId, job.id)
          break
        case ImportJobType.TENANTS:
          result = await this.importTenants(normalizedRows, organizationId, job.id)
          break
        case ImportJobType.LEASES:
          result = await this.importLeases(normalizedRows, organizationId, job.id)
          break
      }

      return await this.prisma.importJob.update({
        where: { id: job.id },
        data: {
          status: ImportJobStatus.COMPLETED,
          totalRows: rows.length,
          processedRows: rows.length,
          successRows: result.successRows,
          errorRows: result.errorRows,
          errors: result.errors as unknown as InputJsonValue,
          completedAt: new Date(),
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Okänt fel'
      return await this.prisma.importJob.update({
        where: { id: job.id },
        data: {
          status: ImportJobStatus.FAILED,
          errors: [{ row: 0, message: msg }] as unknown as InputJsonValue,
          completedAt: new Date(),
        },
      })
    }
  }

  async getImportJobs(organizationId: string) {
    return this.prisma.importJob.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    })
  }

  // ─── Helper Functions ──────────────────────────────────────────────────────

  parseDate(str: string): Date | null {
    if (!str || !str.trim()) return null

    const s = str.trim()

    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const d = new Date(s)
      return isNaN(d.getTime()) ? null : d
    }

    // DD/MM/YYYY or DD-MM-YYYY
    const dmyMatch = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/)
    if (dmyMatch) {
      const d = new Date(
        `${dmyMatch[3] ?? ''}-${(dmyMatch[2] ?? '').padStart(2, '0')}-${(dmyMatch[1] ?? '').padStart(2, '0')}`,
      )
      return isNaN(d.getTime()) ? null : d
    }

    // YYYYMMDD
    if (/^\d{8}$/.test(s)) {
      const d = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`)
      return isNaN(d.getTime()) ? null : d
    }

    // Fallback: native parse
    const d = new Date(s)
    return isNaN(d.getTime()) ? null : d
  }

  parseAmount(str: string): number | null {
    if (!str || !str.trim()) return null

    // Remove spaces, currency symbols, "kr"
    let s = str
      .trim()
      .replace(/\s/g, '')
      .replace(/kr$/i, '')
      .replace(/[^\d,.\-]/g, '')

    // Swedish format: "1 234,56" → "1234.56"
    if (s.includes(',') && !s.includes('.')) {
      s = s.replace(',', '.')
    } else if (s.includes(',') && s.includes('.')) {
      // "1.234,56" → remove dot as thousand separator, replace comma
      s = s.replace(/\./g, '').replace(',', '.')
    }

    const n = parseFloat(s)
    return isNaN(n) ? null : n
  }

  parsePropertyType(str: string): string | null {
    if (!str) return null
    const s = str.toLowerCase().trim()
    if (s.startsWith('bost') || s.startsWith('residential')) return 'RESIDENTIAL'
    if (s.startsWith('komm') || s.startsWith('commercial')) return 'COMMERCIAL'
    if (s.startsWith('bland') || s.startsWith('mixed')) return 'MIXED'
    if (s.startsWith('indust') || s.startsWith('industrial')) return 'INDUSTRIAL'
    if (s.startsWith('mark') || s.startsWith('land')) return 'LAND'
    return null
  }

  parseUnitType(str: string): string | null {
    if (!str) return null
    const s = str.toLowerCase().trim()
    if (s.startsWith('lägenhet') || s.startsWith('apt') || s.startsWith('apartment'))
      return 'APARTMENT'
    if (s.startsWith('kontor') || s.startsWith('office')) return 'OFFICE'
    if (s.startsWith('butik') || s.startsWith('retail')) return 'RETAIL'
    if (s.startsWith('förråd') || s.startsWith('storage')) return 'STORAGE'
    if (s.startsWith('parkering') || s.startsWith('parking')) return 'PARKING'
    return null
  }

  private formatDateToISO(date: Date): string {
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
}
