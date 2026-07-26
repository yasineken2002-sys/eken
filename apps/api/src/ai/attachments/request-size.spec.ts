import { PayloadTooLargeException } from '@nestjs/common'
import {
  ANTHROPIC_MAX_REQUEST_BYTES,
  ATTACHMENT_PAYLOAD_BUDGET_BYTES,
  assertRequestWithinLimit,
  base64Bytes,
  formatMb,
  measureRequestBytes,
} from './request-size'

/**
 * B3 — 32 MB-taket.
 *
 * Det som gör den här modulen värd att testa är BASE64-INFLATIONEN: bilagor
 * går på tråden som base64, 4 byte per 3 råa. Fem filer på 20 MB råa är 100 MB
 * — men 133 MB kodat. Räknas fel valuta ser taket ut att hålla ända tills
 * Anthropic svarar med ett fel.
 */

const imageBlock = (base64Len: number) => ({
  type: 'image' as const,
  source: {
    type: 'base64' as const,
    media_type: 'image/png' as const,
    data: 'a'.repeat(base64Len),
  },
})

describe('base64Bytes', () => {
  it('räknar 4 byte per påbörjad 3-bytegrupp', () => {
    expect(base64Bytes(0)).toBe(0)
    expect(base64Bytes(1)).toBe(4)
    expect(base64Bytes(3)).toBe(4)
    expect(base64Bytes(4)).toBe(8)
    expect(base64Bytes(3 * 1024 * 1024)).toBe(4 * 1024 * 1024)
  })

  it('matchar vad Node faktiskt producerar', () => {
    for (const n of [1, 2, 3, 7, 100, 1023]) {
      expect(base64Bytes(n)).toBe(Buffer.alloc(n).toString('base64').length)
    }
  })

  it('gör 24 MB råa till 32 MB kodade — själva skälet till modulen', () => {
    expect(base64Bytes(24 * 1024 * 1024)).toBe(32 * 1024 * 1024)
  })
})

describe('ATTACHMENT_PAYLOAD_BUDGET_BYTES', () => {
  it('ligger under 32 MB med marginal för text och JSON-skal', () => {
    expect(ATTACHMENT_PAYLOAD_BUDGET_BYTES).toBeLessThan(ANTHROPIC_MAX_REQUEST_BYTES)
    expect(ANTHROPIC_MAX_REQUEST_BYTES - ATTACHMENT_PAYLOAD_BUDGET_BYTES).toBeGreaterThanOrEqual(
      2 * 1024 * 1024,
    )
  })

  it('släpper inte igenom fem maxstora bilagor (20 MB × 5)', () => {
    const fiveMax = 5 * base64Bytes(20 * 1024 * 1024)
    expect(fiveMax).toBeGreaterThan(ATTACHMENT_PAYLOAD_BUDGET_BYTES)
  })
})

describe('measureRequestBytes', () => {
  it('räknar base64-nyttolasten utan att serialisera om den', () => {
    const size = measureRequestBytes({
      messages: [{ role: 'user', content: [imageBlock(1_000_000)] }],
    })
    expect(size).toBeGreaterThanOrEqual(1_000_000)
    // Nära nyttolasten — inte dubbelräknad, inte uppblåst av JSON-escaping.
    expect(size).toBeLessThan(1_000_000 * 1.05)
  })

  it('räknar strängmeddelanden, system och verktyg', () => {
    const size = measureRequestBytes({
      system: [{ type: 'text', text: 'x'.repeat(500) }],
      tools: [{ name: 'y'.repeat(500) }],
      messages: [{ role: 'user', content: 'z'.repeat(500) }],
    })
    expect(size).toBeGreaterThan(1500)
  })

  it('summerar över FLERA meddelanden — historiken räknas med', () => {
    const one = measureRequestBytes({
      messages: [{ role: 'user', content: [imageBlock(100_000)] }],
    })
    const three = measureRequestBytes({
      messages: [
        { role: 'user', content: [imageBlock(100_000)] },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: [imageBlock(100_000)] },
      ],
    })
    expect(three).toBeGreaterThan(one * 2)
  })

  it('hanterar tomma meddelanden utan att kasta', () => {
    expect(measureRequestBytes({ messages: [] })).toBe(0)
  })
})

describe('assertRequestWithinLimit', () => {
  it('släpper igenom en normal request', () => {
    expect(() =>
      assertRequestWithinLimit({
        system: [{ type: 'text', text: 'systemprompt' }],
        messages: [{ role: 'user', content: 'Hur många fastigheter har jag?' }],
      }),
    ).not.toThrow()
  })

  it('kastar 413 — inte ett modell-500 — när requesten spränger taket', () => {
    const huge = { role: 'user' as const, content: [imageBlock(31 * 1024 * 1024)] }
    expect(() => assertRequestWithinLimit({ messages: [huge, huge] })).toThrow(
      PayloadTooLargeException,
    )
  })

  it('fångar fallet där HISTORIKEN spräcker taket, inte det nya meddelandet', () => {
    // Varje enskilt meddelande är litet nog; summan är det inte.
    const messages = Array.from({ length: 6 }, () => ({
      role: 'user' as const,
      content: [imageBlock(6 * 1024 * 1024)],
    }))
    expect(() => assertRequestWithinLimit({ messages })).toThrow(PayloadTooLargeException)
  })

  it('felet innehåller siffror användaren kan agera på', () => {
    const huge = { role: 'user' as const, content: [imageBlock(33 * 1024 * 1024)] }
    try {
      assertRequestWithinLimit({ messages: [huge] })
      fail('skulle ha kastat')
    } catch (error) {
      const msg = (error as Error).message
      expect(msg).toContain('MB')
      expect(msg).toMatch(/32,0 MB/)
      expect(msg).toMatch(/bilaga|konversation/)
    }
  })

  it('kastar redan innan taket nås — marginalen räknas med', () => {
    // Exakt på gränsen minus lite: marginalen (512 KB) ska fälla den ändå.
    const justUnder = ANTHROPIC_MAX_REQUEST_BYTES - 100 * 1024
    expect(() =>
      assertRequestWithinLimit({ messages: [{ role: 'user', content: [imageBlock(justUnder)] }] }),
    ).toThrow(PayloadTooLargeException)
  })
})

describe('formatMb', () => {
  it('skriver svenska decimaler', () => {
    expect(formatMb(32 * 1024 * 1024)).toBe('32,0 MB')
    expect(formatMb(1.5 * 1024 * 1024)).toBe('1,5 MB')
  })
})
