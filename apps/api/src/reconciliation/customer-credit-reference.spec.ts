import { resolveCustomerCreditReference } from './customer-credit-reference'

const noticeNumber = 'AVI-2026-09-0001'
const tenantOcr = '00000000019'

describe('kundtillgodo kräver en entydig avireferens', () => {
  it.each([
    { description: noticeNumber, reference: tenantOcr, rawOcr: tenantOcr },
    { description: `Hyra ${noticeNumber}`, reference: `OCR: ${tenantOcr}`, rawOcr: tenantOcr },
    { description: `Inbetalning ${noticeNumber}`, reference: `OCR ${tenantOcr}`, rawOcr: null },
    { description: tenantOcr, reference: noticeNumber, rawOcr: tenantOcr },
  ])('bevarar avins månad och hela OCR-identiteten: %j', (transaction) => {
    expect(resolveCustomerCreditReference(transaction)).toEqual({
      kind: 'notice',
      noticeNumber,
      ocr: tenantOcr,
    })
  })

  it.each([
    { description: noticeNumber, reference: null, rawOcr: null },
    { description: 'Bankgiro', reference: noticeNumber, rawOcr: null },
    { description: 'Autogiro', reference: noticeNumber, rawOcr: null },
    {
      description: `  betalning ${noticeNumber.toLowerCase()}  `,
      reference: noticeNumber,
      rawOcr: null,
    },
  ])('accepterar en hel referens utan att hitta på OCR: %j', (transaction) => {
    expect(resolveCustomerCreditReference(transaction)).toEqual({
      kind: 'notice',
      noticeNumber,
      ocr: null,
    })
  })

  it.each([
    { description: 'Hyra', reference: tenantOcr, rawOcr: tenantOcr },
    { description: 'Hyra september 2026', reference: null, rawOcr: null },
    { description: 'F-2026-0001', reference: null, rawOcr: null },
    { description: null, reference: null, rawOcr: null },
  ])('lämnar betalningar utan AVI-referens till befintlig matchning: %j', (transaction) => {
    expect(resolveCustomerCreditReference(transaction)).toEqual({ kind: 'none' })
  })

  it.each([
    { description: noticeNumber, reference: 'AVI-2026-10-0001', rawOcr: null },
    { description: `${noticeNumber} AVI-2026-10-0001`, reference: null, rawOcr: null },
    { description: `Inte ${noticeNumber}`, reference: null, rawOcr: null },
    { description: `${noticeNumber} avser oktober`, reference: null, rawOcr: null },
    { description: `${noticeNumber} F-2026-0001`, reference: null, rawOcr: null },
    { description: noticeNumber, reference: 'F-2026-0001', rawOcr: null },
    { description: noticeNumber, reference: 'Hyra oktober', rawOcr: null },
    { description: 'AVI-2026-13-0001', reference: null, rawOcr: null },
    { description: 'AVI-2026-00-0001', reference: null, rawOcr: null },
    { description: 'AVI-2026-09-0001-extra', reference: null, rawOcr: null },
    { description: 'AVI-2026-9-0001', reference: null, rawOcr: null },
    { description: 'AVI-', reference: null, rawOcr: null },
    { description: noticeNumber, reference: tenantOcr, rawOcr: '00000000027' },
    { description: noticeNumber, reference: null, rawOcr: 'OCR 00000000019' },
  ])(
    'stoppar motsägelse eller otillräckligt belägg utan att välja första träffen: %j',
    (transaction) => {
      expect(resolveCustomerCreditReference(transaction)).toEqual({ kind: 'blocked' })
    },
  )

  it('kastar inte bort ett rå-OCR som tidigare extraherats ur avins årtal', () => {
    expect(
      resolveCustomerCreditReference({
        description: 'Hyra',
        reference: noticeNumber,
        rawOcr: '2026',
      }),
    ).toEqual({ kind: 'notice', noticeNumber, ocr: '2026' })
  })
})
