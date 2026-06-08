/**
 * Steg 3, PR 1 — fundament för PDF-/dokumentvarumärke. Verifierar:
 *   • delade varumärkeskonstanter exporteras och hänger ihop (en sanning).
 *   • organizations.service.update SKRIVER de nya fälten när de anges …
 *   • … men UTELÄMNAR dem när de inte anges (befintlig org oförändrad — NULL/
 *     default bevaras, penganeutralt och rendering-neutralt).
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))

import {
  DEFAULT_BRAND_COLOR,
  LEGACY_EMAIL_BRAND_COLOR,
  BRAND_FONTS,
  BRAND_FONT_STACKS,
  BRAND_FONT_LABELS,
  DEFAULT_BRAND_FONT,
  resolveBrandFontStack,
} from '@eken/shared'
import { OrganizationsService } from './organizations.service'

describe('Varumärkeskonstanter (@eken/shared)', () => {
  it('DEFAULT_BRAND_COLOR är dokumentgrönt (sanningen som ersätter splitten)', () => {
    expect(DEFAULT_BRAND_COLOR).toBe('#1a6b3c')
    expect(LEGACY_EMAIL_BRAND_COLOR).toBe('#2563EB')
  })

  it('SYSTEM_SANS är default och finns i listan (= nuvarande hårdkodade typsnitt)', () => {
    expect(DEFAULT_BRAND_FONT).toBe('SYSTEM_SANS')
    expect(BRAND_FONTS).toContain('SYSTEM_SANS')
  })

  it('varje font-val har en stack och en etikett (inga luckor)', () => {
    for (const f of BRAND_FONTS) {
      expect(typeof BRAND_FONT_STACKS[f]).toBe('string')
      expect(BRAND_FONT_STACKS[f].length).toBeGreaterThan(0)
      expect(typeof BRAND_FONT_LABELS[f]).toBe('string')
    }
  })

  it('resolveBrandFontStack faller tillbaka till default vid null/okänt', () => {
    expect(resolveBrandFontStack('GEORGIA')).toBe(BRAND_FONT_STACKS.GEORGIA)
    expect(resolveBrandFontStack(null)).toBe(BRAND_FONT_STACKS[DEFAULT_BRAND_FONT])
    expect(resolveBrandFontStack(undefined)).toBe(BRAND_FONT_STACKS[DEFAULT_BRAND_FONT])
    expect(resolveBrandFontStack('NONSENS')).toBe(BRAND_FONT_STACKS[DEFAULT_BRAND_FONT])
  })
})

function makeService() {
  const update = jest
    .fn()
    .mockImplementation(({ data }) => Promise.resolve({ id: 'org-1', ...data }))
  const prisma = { organization: { update } }
  const service = new OrganizationsService(prisma as never, {} as never)
  return { service, update }
}

describe('OrganizationsService.update — varumärkesfält', () => {
  it('skriver brandFont och brandSecondaryColor när de anges', async () => {
    const { service, update } = makeService()
    await service.update('org-1', {
      brandFont: 'GEORGIA' as never,
      brandSecondaryColor: '#2563EB',
    })
    const data = update.mock.calls[0][0].data
    expect(data.brandFont).toBe('GEORGIA')
    expect(data.brandSecondaryColor).toBe('#2563EB')
  })

  it('UTELÄMNAR fälten helt när de inte anges (befintlig org oförändrad)', async () => {
    const { service, update } = makeService()
    await service.update('org-1', { invoiceColor: '#1a3a6b' })
    const data = update.mock.calls[0][0].data
    expect('brandFont' in data).toBe(false)
    expect('brandSecondaryColor' in data).toBe(false)
    // ingen oavsiktlig nollställning av sekundärfärgen
    expect(data.brandSecondaryColor).toBeUndefined()
  })

  it('kan sätta bara brandFont utan att röra sekundärfärgen', async () => {
    const { service, update } = makeService()
    await service.update('org-1', { brandFont: 'INTER' as never })
    const data = update.mock.calls[0][0].data
    expect(data.brandFont).toBe('INTER')
    expect('brandSecondaryColor' in data).toBe(false)
  })
})
