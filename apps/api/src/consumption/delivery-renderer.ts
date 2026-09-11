import { ConflictException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { DEFAULT_BRAND_COLOR } from '@eken/shared'
import type { Invoice, Organization, RentNotice, Tenant } from '@prisma/client'
import { PdfService } from '../invoices/pdf.service'
import { documentContext, renderingCodeIdentity } from '../invoices/rendering-context'
import { detectMime } from '../invoices/templates/invoice-pdf.template'
import { AviseringService } from '../avisering/avisering.service'
import { rentNoticePayableTotal } from '../common/utils/rent-notice-total.util'
import { MailService } from '../mail/mail.service'
import { MailRenderer } from '../mail/mail.renderer'
import { deliveryDigest } from './delivery-execution'
import type { DeliveryResources, DeliveryPacket } from './delivery-execution'
import type { DeliveryDecisionCommand } from './delivery-decisions'

type FrozenRendering = Prisma.InputJsonObject & {
  version: 'delivery-rendering/v1'
  asOf: string
  from: string
  environment: string
  logo: { key: string; mime: string; base64: string } | null
}
const fail = (code = 'DELIVERY_RENDER_INPUT_INVALID'): never => {
  throw new ConflictException(code)
}
function date(value: unknown): Date {
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value)) value += 'T00:00:00Z'
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z?$/.test(value))
    return fail()
  const result = new Date(value.endsWith('Z') ? value : value + 'Z')
  if (
    !Number.isFinite(result.getTime()) ||
    result.toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    return fail()
  return result
}
// SQL delivery_json serializes numbers as strings. Validate before constructing runtime types.
function decode<T>(model: string, value: Prisma.JsonValue, complete = true): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const result: Record<string, unknown> = { ...value }
  for (const field of Prisma.dmmf.datamodel.models.find((entry) => entry.name === model)!.fields) {
    if (field.kind === 'object') continue
    const raw = value[field.name]
    if (raw === undefined && !complete) continue
    if (raw === null && !field.isRequired) continue
    if (field.type === 'DateTime') result[field.name] = date(raw)
    else if (['Int', 'Float', 'Decimal'].includes(field.type)) {
      if (typeof raw !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(raw)) return fail()
      const decimal = new Prisma.Decimal(raw)
      const number = Number(raw)
      if (
        !Number.isFinite(number) ||
        !decimal.equals(String(number)) ||
        (field.type === 'Int' && !Number.isSafeInteger(number))
      )
        return fail()
      result[field.name] = field.type === 'Decimal' ? decimal : number
    } else if (
      field.type === 'Boolean'
        ? typeof raw !== 'boolean'
        : field.type === 'String' || field.kind === 'enum'
          ? typeof raw !== 'string'
          : false
    )
      return fail()
  }
  return result as T
}

// No DB, storage or configuration dependency: inputs are carried by the decision command.
export class DeliveryRenderer {
  constructor(
    private readonly pdf: PdfService,
    private readonly mail: MailRenderer,
  ) {}

  async freeze(
    asOf: string,
    from: string,
    logo: FrozenRendering['logo'],
  ): Promise<FrozenRendering> {
    const context = await this.pdf.createRenderingContext(date(asOf), null)
    return { version: 'delivery-rendering/v1', asOf, from, logo, environment: context.environment }
  }

  async resources(input?: Prisma.InputJsonObject): Promise<DeliveryResources> {
    const frozen = this.context(input)
    try {
      const current = await this.pdf.createRenderingContext(date(frozen.asOf), null)
      return {
        'renderer/environment': Buffer.from(current.environment).toString('base64'),
        ...(frozen.logo ? { ['logo/' + frozen.logo.key]: frozen.logo.base64 } : {}),
      }
    } catch {
      return fail('RENDER_IDENTITY_CONFLICT')
    }
  }

  private context(input?: Prisma.InputJsonObject): FrozenRendering {
    const value = input as FrozenRendering | undefined
    if (
      !value ||
      value.version !== 'delivery-rendering/v1' ||
      typeof value.from !== 'string' ||
      !value.from.trim() ||
      typeof value.environment !== 'string'
    )
      return fail()
    date(value.asOf)
    if (
      value.logo !== null &&
      (!value.logo ||
        typeof value.logo.key !== 'string' ||
        !value.logo.key ||
        value.logo.mime !== detectMime(value.logo.key) ||
        typeof value.logo.base64 !== 'string' ||
        !value.logo.base64 ||
        Buffer.from(value.logo.base64, 'base64').toString('base64') !== value.logo.base64)
    )
      return fail()
    return value
  }

  async render(
    snapshot: Prisma.JsonValue,
    resources: DeliveryResources,
    input?: Prisma.InputJsonObject,
  ) {
    const frozen = this.context(input)
    const expected = {
      'renderer/environment': Buffer.from(frozen.environment).toString('base64'),
      ...(frozen.logo ? { ['logo/' + frozen.logo.key]: frozen.logo.base64 } : {}),
    }
    for (const actual of [resources, await this.resources(frozen)]) {
      if (
        Object.keys(actual).length !== Object.keys(expected).length ||
        Object.entries(expected).some(([key, bytes]) => actual[key] !== bytes)
      )
        return fail('RENDER_IDENTITY_CONFLICT')
    }
    const s = snapshot as Prisma.JsonObject
    if (s.contract !== 'delivery-domain/v1' || !Array.isArray(s.lines) || !Array.isArray(s.credits))
      return fail()
    const isInvoice = typeof (s.document as Prisma.JsonObject)?.invoiceNumber === 'string'
    const org = decode<Organization>('Organization', s.sender!, false)
    const party = decode<Tenant>(
      isInvoice && (s.document as Prisma.JsonObject).customerId ? 'Customer' : 'Tenant',
      s.recipient!,
      false,
    )
    const context = {
      ...documentContext(
        date(frozen.asOf),
        frozen.logo ? `data:${frozen.logo.mime};base64,${frozen.logo.base64}` : null,
      ),
      environment: frozen.environment,
    }
    if ((org.logoStorageKey ?? null) !== (frozen.logo?.key ?? null))
      return fail('DELIVERY_RESOURCE_CONFLICT')
    const common = {
      to: party.email!,
      organizationId: org.id,
      organizationName: org.name,
      tenantName:
        party.type === 'INDIVIDUAL'
          ? `${party.firstName ?? ''} ${party.lastName ?? ''}`.trim()
          : (party.companyName ?? party.email!),
    }
    let payload
    if (isInvoice) {
      const invoice = decode<Invoice>('Invoice', s.document!)
      const data: Parameters<PdfService['renderInvoice']>[0] = {
        invoiceColor: org.invoiceColor ?? DEFAULT_BRAND_COLOR,
        invoiceTemplate: org.invoiceTemplate ?? 'classic',
        logoBase64: frozen.logo?.base64 ?? null,
        invoice: {
          ...invoice,
          lines: s.lines.map((line) => decode('InvoiceLine', line)),
          tenant: {
            ...party,
            email: party.email!,
            address: party.street
              ? { street: party.street, city: party.city ?? '', postalCode: party.postalCode ?? '' }
              : null,
          },
          organization: { ...org, logoUrl: org.logoStorageKey },
        },
      }
      payload = MailService.buildInvoice({
        ...common,
        invoiceNumber: invoice.invoiceNumber,
        total: Number(invoice.total),
        dueDate: invoice.dueDate,
        pdfBuffer: await this.pdf.renderInvoice(data, context),
      })
    } else {
      type Notice = Parameters<typeof AviseringService.buildNoticePdfHtml>[0]
      const document = decode<RentNotice>('RentNotice', s.document!)
      if (document.month < 1 || document.month > 12 || document.year < 1 || document.year > 9999)
        return fail()
      const notice: Notice = {
        ...document,
        tenant: party,
        lines: s.lines.map((line) => decode('RentNoticeLine', line)),
        credits: s.credits.map((credit) => decode('RentNoticeCredit', credit)),
        lease: {
          ...decode<Notice['lease']>('Lease', s.lease!),
          unit: {
            ...decode<Notice['lease']['unit']>('Unit', s.unit!),
            property: decode('Property', s.property!),
          },
        },
      }
      payload = MailService.buildRentNotice({
        ...common,
        rentNoticeId: document.id,
        noticeNumber: document.noticeNumber,
        ocrNumber: document.ocrNumber,
        amount: rentNoticePayableTotal(notice),
        dueDate: document.dueDate,
        accentColor: org.invoiceColor ?? DEFAULT_BRAND_COLOR,
        pdfBuffer: await this.pdf.generateFromHtml(
          AviseringService.buildNoticePdfHtml(notice, org, context),
          context,
        ),
      })
    }
    const rendered = await this.mail.render(payload.template, payload.props, {
      environment: renderingCodeIdentity(),
    })
    return JSON.stringify({
      from: frozen.from,
      to: [payload.to],
      subject: payload.subject,
      html: rendered.html,
      text: rendered.text,
      attachments: payload.attachments!.map((item) => ({
        filename: item.filename,
        content: item.content.toString('base64'),
        content_type: 'application/pdf',
      })),
    })
  }

  async reproduce(
    snapshot: Prisma.JsonValue,
    command: DeliveryDecisionCommand,
    sealed: Pick<DeliveryPacket, 'body' | 'digest'>,
  ) {
    const resources = await this.resources(command.rendering)
    if (
      !command.resources ||
      Object.keys(resources).length !== Object.keys(command.resources).length ||
      Object.entries(resources).some(
        ([key, bytes]) => deliveryDigest(Buffer.from(bytes, 'base64')) !== command.resources![key],
      )
    )
      return fail('RENDER_IDENTITY_CONFLICT')
    const body = await this.render(snapshot, resources, command.rendering)
    if (body !== sealed.body || deliveryDigest(body) !== sealed.digest)
      return fail('DELIVERY_ARTIFACT_CONFLICT')
    return body // Proof only; never replaces a dispatch or grants transport authority.
  }
}
