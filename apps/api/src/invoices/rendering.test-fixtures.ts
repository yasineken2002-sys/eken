/**
 * Syntetiska före-fixturer för 2.1. Ingen produktionskod importerar denna fil.
 * Alla datum, identifierare, radordningar och resurser är uttryckliga data.
 * Fabriken skapar nya Date/objekt; JSON.stringify ger ett stabilt frysbart underlag.
 * Inga personnummer finns i fixturerna, och alla e-postadresser använder example.test.
 */
export const renderingFixtureBaseSha = '5ae9906b152307eae0d79eec719d4303a042742c'
export const renderingFixtureAsOf = '2026-09-11T12:00:00Z'

export const renderingFixtureLogo = {
  storageKey: 'synthetic/rendering/org-logo.png',
  mediaType: 'image/png',
  base64:
    'iVBORw0KGgoAAAANSUhEUgAAAGAAAAAgCAIAAABiouoDAAAAWElEQVR42u3YMQ0AIAxFwepAC47wPxcHTRhgKPfzFNzUNMaaKgoEgAABAvQ9UJYD1BEoDwcIECBAPYHy8gABAgQIECBAgByKgAAB8jADBMjTHpAAAQL0qA0wt0PC6qoY3AAAAABJRU5ErkJggg==',
}

export interface RenderingFixtureLine {
  id: string
  description: string
  quantity: number
  unitPrice: number
  vatRate: number
  total: number
}

export function createRenderingFixtures() {
  const organization = {
    id: 'synthetic-rendering-org',
    name: 'Syntetiska Fastigheter AB',
    orgNumber: 'TEST-ORG-001',
    street: 'Testgatan 12',
    postalCode: '000 00',
    city: 'Teststaden',
    email: 'ekonomi@example.test',
    phone: 'TEST-TELEFON',
    bankgiro: '5050-1055',
    invoiceColor: '#1a6b3c',
    invoiceTemplate: 'classic',
    brandSecondaryColor: '#245c7c',
    brandFont: 'SYSTEM_SANS',
    logoStorageKey: renderingFixtureLogo.storageKey,
    hasFSkatt: true,
    fSkattApprovedDate: new Date('2020-01-15T00:00:00Z'),
    vatNumber: 'SETESTORG001',
    companyForm: 'AB',
    collectionAgencyName: 'Syntetisk kravmottagare',
  }
  const tenant = {
    id: 'synthetic-rendering-tenant',
    type: 'INDIVIDUAL',
    firstName: 'Testa',
    lastName: 'Åberg',
    companyName: null,
    personalNumberEnc: null,
    orgNumber: null,
    email: 'testa.aberg@example.test',
    phone: null,
    street: 'Exempelvägen 4',
    postalCode: '000 01',
    city: 'Teststaden',
  }
  const customer = {
    ...tenant,
    id: 'synthetic-rendering-customer',
    type: 'COMPANY',
    firstName: null,
    lastName: null,
    companyName: 'Syntetisk Kund AB',
    orgNumber: 'TEST-KUND-002',
    email: 'kund@example.test',
    street: 'Kundgatan 9',
  }
  const lease = {
    id: 'synthetic-rendering-lease',
    monthlyRent: 9000,
    unit: {
      id: 'synthetic-rendering-unit',
      unitNumber: '1101',
      name: 'Lägenhet 1101',
      property: { id: 'synthetic-rendering-property', name: 'Testhuset', street: 'Testgatan 12' },
    },
  }
  const serviceLines: RenderingFixtureLine[] = [
    {
      id: 'line-020',
      description: 'Lokalservice september',
      quantity: 2,
      unitPrice: 400,
      vatRate: 25,
      total: 1000,
    },
    {
      id: 'line-010',
      description: 'Material för lokalservice',
      quantity: 1,
      unitPrice: 80,
      vatRate: 25,
      total: 100,
    },
  ]
  const rentLines: RenderingFixtureLine[] = [
    {
      id: 'line-030',
      description: 'Hyra september 2026',
      quantity: 1,
      unitPrice: 9000,
      vatRate: 0,
      total: 9000,
    },
  ]
  const utilityLines: RenderingFixtureLine[] = [
    {
      id: 'line-050',
      description: 'El juli 2026, 100 kWh',
      quantity: 100,
      unitPrice: 2,
      vatRate: 25,
      total: 250,
    },
    {
      id: 'line-040',
      description: 'Vatten juli 2026, 4 m³',
      quantity: 4,
      unitPrice: 50,
      vatRate: 25,
      total: 250,
    },
  ]
  const invoice = (
    id: string,
    type: string,
    lines: RenderingFixtureLine[],
    forCustomer: boolean,
  ) => {
    const subtotal = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0)
    const total = lines.reduce((sum, line) => sum + line.total, 0)
    return {
      id,
      organizationId: organization.id,
      invoiceNumber: `F-SYN-2026-${id}`,
      type,
      status: 'DRAFT',
      issueDate: new Date('2026-08-31T00:00:00Z'),
      dueDate: new Date('2026-09-30T00:00:00Z'),
      reference: 'Syntetisk beställning 2026',
      ocrNumber: '1234567897',
      subtotal,
      vatTotal: total - subtotal,
      total,
      notes: null,
      lines: structuredClone(lines),
      tenant: forCustomer ? null : structuredClone(tenant),
      customer: forCustomer ? structuredClone(customer) : null,
      organization: structuredClone(organization),
      lease: structuredClone(lease),
      payments: [] as Array<{ amount: number; paidAt: Date }>,
      creditNotes: [] as Array<{ total: number }>,
      paymentReminders: [] as Array<{ type: string; sentAt: Date; feeAmount: number }>,
    }
  }
  const customerInvoice = invoice('customer-classic', 'SERVICE', serviceLines, true)
  const rentInvoice = invoice('rent-classic', 'RENT', rentLines, false)
  const utilityInvoice = invoice('utility-classic', 'UTILITY', utilityLines, false)
  const longLines: RenderingFixtureLine[] = Array.from({ length: 55 }, (_, index) => ({
    id: `long-line-${String(55 - index).padStart(3, '0')}`,
    description: `Planerat servicearbete ${String(index + 1).padStart(2, '0')} — kontroll av lokal och utrustning`,
    quantity: 1,
    unitPrice: 100,
    vatRate: 25,
    total: 125,
  }))
  const invoiceCases = [
    { id: 'invoice-customer-classic', document: customerInvoice, hasConsumption: false },
    { id: 'invoice-rent-classic', document: rentInvoice, hasConsumption: false },
    { id: 'invoice-utility-classic', document: utilityInvoice, hasConsumption: true },
    {
      id: 'invoice-customer-modern',
      document: {
        ...structuredClone(customerInvoice),
        organization: { ...organization, invoiceTemplate: 'modern' },
      },
      hasConsumption: false,
    },
    {
      id: 'invoice-customer-minimal',
      document: {
        ...structuredClone(customerInvoice),
        organization: { ...organization, invoiceTemplate: 'minimal' },
      },
      hasConsumption: false,
    },
    {
      id: 'invoice-customer-multipage',
      document: invoice('customer-multipage', 'SERVICE', longLines, true),
      hasConsumption: false,
    },
  ]
  const notice = {
    id: 'synthetic-notice-rent',
    organizationId: organization.id,
    noticeNumber: 'AVI-SYN-2026-0901',
    ocrNumber: '1234567897',
    type: 'RENT',
    status: 'PENDING',
    year: 2026,
    month: 9,
    createdAt: new Date('2026-08-20T10:00:00Z'),
    dueDate: new Date('2026-09-30T00:00:00Z'),
    amount: 9000,
    vatAmount: 0,
    totalAmount: 9000,
    consumptionAmount: 0,
    miscChargeAmount: 0,
    reminderFeeAmount: 0,
    interestAccruedAmount: 0,
    isProrated: false,
    isBackfill: false,
    periodStart: null as Date | null,
    periodEnd: null as Date | null,
    totalDays: null as number | null,
    daysCharged: null as number | null,
    tenant: structuredClone(tenant),
    organization: structuredClone(organization),
    lease: structuredClone(lease),
    lines: [] as Array<RenderingFixtureLine & { consumptionChargeId: string; createdAt: Date }>,
    credits: [] as Array<{ id: string; amount: number }>,
    payments: [] as Array<{ id: string; amount: number; paidAt: Date }>,
  }
  const utilityNotice = {
    ...structuredClone(notice),
    id: 'synthetic-notice-utility',
    noticeNumber: 'AVI-SYN-2026-0904',
    consumptionAmount: 500,
    lines: utilityLines.map((line, index) => ({
      ...line,
      consumptionChargeId: `synthetic-charge-${index + 1}`,
      createdAt: new Date(`2026-08-20T10:00:0${index + 1}Z`),
    })),
    credits: [{ id: 'synthetic-credit-001', amount: 100 }],
  }
  const noticeCases = [
    { id: 'notice-rent', document: structuredClone(notice), hasConsumption: false },
    {
      id: 'notice-prorated-backfill',
      document: {
        ...structuredClone(notice),
        id: 'synthetic-notice-backfill',
        noticeNumber: 'AVI-SYN-2026-0902',
        month: 6,
        amount: 4500,
        totalAmount: 4500,
        isProrated: true,
        isBackfill: true,
        periodStart: new Date('2026-06-16T00:00:00Z'),
        periodEnd: new Date('2026-06-30T00:00:00Z'),
        totalDays: 30,
        daysCharged: 15,
      },
      hasConsumption: false,
    },
    {
      id: 'notice-deposit',
      document: {
        ...structuredClone(notice),
        id: 'synthetic-notice-deposit',
        noticeNumber: 'AVI-SYN-2026-0903',
        type: 'DEPOSIT',
        amount: 18000,
        totalAmount: 18000,
      },
      hasConsumption: false,
    },
    { id: 'notice-utility-credit', document: structuredClone(utilityNotice), hasConsumption: true },
  ]
  const reminder = (source: typeof notice) => ({
    ...structuredClone(source),
    status: 'OVERDUE',
    dueDate: new Date('2026-08-31T00:00:00Z'),
    reminderFeeAmount: 60,
    payments: [
      { id: 'synthetic-payment-001', amount: 4000, paidAt: new Date('2026-09-02T00:00:00Z') },
    ],
  })
  const reminderCases = [
    { id: 'reminder-rent-partpaid', document: reminder(notice), hasConsumption: false },
    {
      id: 'reminder-utility-partpaid-credit',
      document: reminder(utilityNotice),
      hasConsumption: true,
    },
  ]
  const invoiceCollection = (source: typeof customerInvoice) => ({
    ...structuredClone(source),
    status: 'OVERDUE',
    issueDate: new Date('2026-06-30T00:00:00Z'),
    dueDate: new Date('2026-07-31T00:00:00Z'),
    total: source.total + 60,
    lines: [
      ...structuredClone(source.lines),
      {
        id: 'line-fee',
        description: 'Påminnelseavgift',
        quantity: 1,
        unitPrice: 60,
        vatRate: 0,
        total: 60,
      },
    ],
    payments: [{ amount: 200, paidAt: new Date('2026-08-15T00:00:00Z') }],
    paymentReminders: [
      { type: 'REMINDER_FRIENDLY', sentAt: new Date('2026-08-07T00:00:00Z'), feeAmount: 0 },
      { type: 'REMINDER_FORMAL', sentAt: new Date('2026-08-14T00:00:00Z'), feeAmount: 60 },
    ],
  })
  const invoiceCollectionCases = [
    {
      id: 'collection-invoice-clean',
      document: invoiceCollection(customerInvoice),
      hasConsumption: false,
    },
    {
      id: 'collection-invoice-utility',
      document: invoiceCollection(utilityInvoice),
      hasConsumption: true,
    },
  ]
  const rentCollection = (source: typeof notice) => ({
    ...structuredClone(source),
    status: 'OVERDUE',
    collectionStage: 'INKASSO_READY',
    dueDate: new Date('2026-07-31T00:00:00Z'),
    sentAt: new Date('2026-07-20T00:00:00Z'),
    remindedAt: new Date('2026-08-07T00:00:00Z'),
    collectionReadyAt: new Date('2026-09-10T00:00:00Z'),
    reminderFeeAmount: 60,
    interestAccruedAmount: source.consumptionAmount === 0 ? 103.56 : 108.17,
    interestAccruedThrough: new Date('2026-09-09T00:00:00Z'),
    reminderPdfStorageKey: 'synthetic/rendering/reminder.pdf',
    events: [
      { type: 'EMAIL_DELIVERED', createdAt: new Date('2026-08-08T00:00:00Z'), payload: {} },
      {
        type: 'INTEREST_ACCRUED',
        createdAt: new Date('2026-09-10T00:00:00Z'),
        payload: {
          segments: [
            {
              from: '2026-08-01',
              to: '2026-08-31',
              days: 31,
              referenceRatePercent: 2.5,
              effectiveRatePercent: 10.5,
              amount: source.consumptionAmount === 0 ? 80.26 : 83.83,
            },
            {
              from: '2026-09-01',
              to: '2026-09-09',
              days: 9,
              referenceRatePercent: 2.5,
              effectiveRatePercent: 10.5,
              amount: source.consumptionAmount === 0 ? 23.3 : 24.34,
            },
          ],
        },
      },
    ],
  })
  const rentCollectionCases = [
    { id: 'collection-notice-clean', document: rentCollection(notice), hasConsumption: false },
    {
      id: 'collection-notice-utility-credit',
      document: rentCollection(utilityNotice),
      hasConsumption: true,
    },
  ]
  return {
    organization,
    invoiceCases,
    noticeCases,
    reminderCases,
    invoiceCollectionCases,
    rentCollectionCases,
  }
}

export type RenderingFixtures = ReturnType<typeof createRenderingFixtures>
