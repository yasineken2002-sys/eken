import { renderToStaticMarkup } from 'react-dom/server'
import * as React from 'react'
import { DEFAULT_BRAND_COLOR, LEGACY_EMAIL_BRAND_COLOR } from '@eken/shared'
import { MagicLink } from './templates/auth/MagicLink'
import { InvoiceCreated } from './templates/invoices/InvoiceCreated'
import { TenantInvite } from './templates/tenants/TenantInvite'
import { TenantPortalInvite } from './templates/tenants/TenantPortalInvite'
import { TenantActivationReminder } from './templates/tenants/TenantActivationReminder'
import { TenantSignatureConfirmation } from './templates/tenants/TenantSignatureConfirmation'
import { TenantWelcomeWithContract } from './templates/tenants/TenantWelcomeWithContract'
import { MaintenanceUpdate } from './templates/notifications/MaintenanceUpdate'
import { EmailLayout } from './templates/base/EmailLayout'
import { UserInvite } from './templates/users/UserInvite'
import { PasswordReset } from './templates/users/PasswordReset'

/**
 * Steg 4 — färgharmonisering av e-post mot PDF-varumärket.
 *
 * Hyresgäst-mejlens accentfärg ska vara DEFAULT_BRAND_COLOR (samma som
 * dokumenten), och den gamla e-post-gröna #2D6A4F får inte finnas kvar.
 * Operatörens system-mejl (lösenord, användar-inbjudan) ska däremot behålla
 * sin blå CTA-/länkaccent (#2563EB = LEGACY_EMAIL_BRAND_COLOR) — den handlar
 * om Eveno-kontot och matchar web-appens primärfärg.
 *
 * OBS: den gamla e-post-gröna som literal, så bytet verkligen verifieras.
 */
const LEGACY_EMAIL_GREEN = '#2D6A4F'

// renderToStaticMarkup (synkron, CJS-vänlig) serialiserar inline-style-färgerna
// — exakt de literaler PR:en harmoniserar — utan @react-email/render-dynimport.
const renderHtml = (el: React.ReactElement): string => renderToStaticMarkup(el)

describe('E-post — färgharmonisering mot PDF-varumärket', () => {
  describe('Hyresgäst-mejl använder DEFAULT_BRAND_COLOR (ej gammelgrön)', () => {
    const cases: Array<[string, React.ReactElement]> = [
      [
        'MagicLink',
        React.createElement(MagicLink, {
          tenantName: 'Anna',
          magicUrl: 'https://x.se/l',
          organizationName: 'Värd AB',
        }),
      ],
      [
        'InvoiceCreated',
        React.createElement(InvoiceCreated, {
          tenantName: 'Anna',
          invoiceNumber: 'F-1',
          total: 1000,
          dueDate: '2026-07-01',
          organizationName: 'Värd AB',
        }),
      ],
      [
        'TenantInvite',
        React.createElement(TenantInvite, {
          tenantName: 'Anna',
          magicUrl: 'https://x.se/l',
          organizationName: 'Värd AB',
        }),
      ],
      [
        'TenantPortalInvite',
        React.createElement(TenantPortalInvite, {
          tenantName: 'Anna',
          activationUrl: 'https://x.se/a',
          organizationName: 'Värd AB',
        }),
      ],
      [
        'TenantActivationReminder',
        React.createElement(TenantActivationReminder, {
          tenantName: 'Anna',
          activationUrl: 'https://x.se/a',
          organizationName: 'Värd AB',
        }),
      ],
      [
        'TenantSignatureConfirmation',
        React.createElement(TenantSignatureConfirmation, {
          tenantName: 'Anna',
          organizationName: 'Värd AB',
          documentsUrl: 'https://x.se/d',
          signedAt: '2026-06-09',
        }),
      ],
      [
        'TenantWelcomeWithContract',
        React.createElement(TenantWelcomeWithContract, {
          tenantName: 'Anna',
          organizationName: 'Värd AB',
          activationUrl: 'https://x.se/a',
        }),
      ],
      [
        'MaintenanceUpdate',
        React.createElement(MaintenanceUpdate, {
          tenantName: 'Anna',
          organizationName: 'Värd AB',
          ticketNumber: 'A-1',
          ticketTitle: 'Läcka',
          newStatus: 'Pågående',
        }),
      ],
    ]

    it.each(cases)('%s renderar med varumärkesfärgen', async (_name, el) => {
      const html = renderHtml(el).toLowerCase()
      expect(html).toContain(DEFAULT_BRAND_COLOR.toLowerCase())
      expect(html).not.toContain(LEGACY_EMAIL_GREEN.toLowerCase())
    })
  })

  it('Delad EmailLayout-header använder varumärkesfärgen', async () => {
    const html = renderHtml(
      React.createElement(EmailLayout, {
        preview: 'p',
        organizationName: 'Värd AB',
        children: 'x',
      }),
    ).toLowerCase()
    expect(html).toContain(DEFAULT_BRAND_COLOR.toLowerCase())
    expect(html).not.toContain(LEGACY_EMAIL_GREEN.toLowerCase())
  })

  describe('Operatörsmejl behåller sin blå CTA-/länkaccent', () => {
    it('UserInvite har kvar blå accent', async () => {
      const html = renderHtml(
        React.createElement(UserInvite, {
          recipientName: 'Kalle',
          roleLabel: 'Admin',
          invitedBy: 'Anna',
          acceptUrl: 'https://x.se/a',
          organizationName: 'Värd AB',
        }),
      ).toLowerCase()
      expect(html).toContain(LEGACY_EMAIL_BRAND_COLOR.toLowerCase())
    })

    it('PasswordReset har kvar blå accent', async () => {
      const html = renderHtml(
        React.createElement(PasswordReset, {
          recipientName: 'Kalle',
          resetUrl: 'https://x.se/r',
          organizationName: 'Värd AB',
        }),
      ).toLowerCase()
      expect(html).toContain(LEGACY_EMAIL_BRAND_COLOR.toLowerCase())
    })
  })
})
