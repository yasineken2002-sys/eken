/**
 * OPTIMIZATION — tools-blocket har ett eget prompt-cache-breakpoint så att de
 * statiska verktygsdefinitionerna cachas oberoende av det volatila system-
 * blocket (portföljdata). cache_read kan inte verifieras utan ett live-anrop;
 * detta strukturella test säkerställer att breakpointen finns och ligger sist.
 */

jest.mock('../storage/storage.service', () => ({ StorageService: class {} }))
jest.mock('../invoices/pdf.service', () => ({ PdfService: class {} }))

import { TOOLS } from './tools/ai-tools.definition'
import { TENANT_TOOLS } from './tools/tenant-ai-tools.definition'

type Cacheable = { cache_control?: { type: string } }

describe('Prompt caching — tools cache breakpoint', () => {
  it('sista verktyget i TOOLS har cache_control: ephemeral', () => {
    const last = TOOLS[TOOLS.length - 1] as Cacheable
    expect(last.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('endast EXAKT ett tools-breakpoint finns (annars slösas cache-segment)', () => {
    const withCache = (TOOLS as Cacheable[]).filter((t) => t.cache_control)
    expect(withCache).toHaveLength(1)
  })

  it('sista verktyget i TENANT_TOOLS har cache_control: ephemeral', () => {
    const last = TENANT_TOOLS[TENANT_TOOLS.length - 1] as Cacheable
    expect(last.cache_control).toEqual({ type: 'ephemeral' })
  })
})
