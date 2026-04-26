import { Injectable, Logger } from '@nestjs/common'
import { render } from '@react-email/render'
import * as crypto from 'crypto'
import * as React from 'react'
import { Custom } from './templates/base/Custom'
import { MagicLink } from './templates/auth/MagicLink'
import { InvoiceCreated } from './templates/invoices/InvoiceCreated'
import { InvoiceReminder } from './templates/invoices/InvoiceReminder'
import { InvoiceOverdue } from './templates/invoices/InvoiceOverdue'
import { TenantWelcome } from './templates/tenants/TenantWelcome'
import { TenantInvite } from './templates/tenants/TenantInvite'
import { MaintenanceUpdate } from './templates/notifications/MaintenanceUpdate'
import { PasswordReset } from './templates/users/PasswordReset'
import { UserInvite } from './templates/users/UserInvite'
import type { TemplateName, TemplatePropsMap } from './mail.types'

type AnyTemplateProps = TemplatePropsMap[TemplateName]
type TemplateComponent = (props: AnyTemplateProps) => React.ReactElement

const TEMPLATE_REGISTRY: Record<TemplateName, TemplateComponent> = {
  'magic-link': MagicLink as TemplateComponent,
  'invoice-created': InvoiceCreated as TemplateComponent,
  'invoice-reminder': InvoiceReminder as TemplateComponent,
  'invoice-overdue': InvoiceOverdue as TemplateComponent,
  'tenant-welcome': TenantWelcome as TemplateComponent,
  'tenant-invite': TenantInvite as TemplateComponent,
  'maintenance-update': MaintenanceUpdate as TemplateComponent,
  'password-reset': PasswordReset as TemplateComponent,
  'user-invite': UserInvite as TemplateComponent,
  custom: Custom as TemplateComponent,
}

interface RenderResult {
  html: string
  text: string
}

const CACHE_MAX_ENTRIES = 256

@Injectable()
export class MailRenderer {
  private readonly logger = new Logger(MailRenderer.name)
  private readonly cache = new Map<string, RenderResult>()

  /**
   * Renderar en template till HTML + plain-text.
   * Cache:ar identiska prop-kombinationer (samma cacheKey = samma output)
   * eftersom React Email-rendering är CPU-tungt.
   */
  async render<T extends TemplateName>(
    template: T,
    props: TemplatePropsMap[T],
  ): Promise<RenderResult> {
    const cacheKey = this.computeCacheKey(template, props)
    const cached = this.cache.get(cacheKey)
    if (cached) return cached

    const Component = TEMPLATE_REGISTRY[template]
    if (!Component) {
      throw new Error(`Okänd mail-template: ${template}`)
    }

    const element = React.createElement(Component, props as AnyTemplateProps)

    const [html, text] = await Promise.all([
      render(element, { pretty: false }),
      render(element, { plainText: true }),
    ])

    const result: RenderResult = { html, text }

    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      // Trim oldest entry — Map preserves insertion order
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) this.cache.delete(firstKey)
    }
    this.cache.set(cacheKey, result)

    return result
  }

  private computeCacheKey(template: TemplateName, props: unknown): string {
    const serialized = stableStringify(props)
    const hash = crypto.createHash('sha1').update(serialized).digest('hex')
    return `${template}:${hash}`
  }
}

/**
 * Stabil JSON-serialisering: nycklar sorteras, så identiskt innehåll i olika
 * objektordning ger samma cache-nyckel.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  )
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',') + '}'
}
