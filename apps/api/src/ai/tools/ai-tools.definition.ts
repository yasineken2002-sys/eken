import type Anthropic from '@anthropic-ai/sdk'

export const TOOLS: Anthropic.Tool[] = [
  // ── READ TOOLS (no confirmation needed) ──────────────────────────────────

  {
    name: 'get_dashboard_stats',
    description:
      'Hämtar övergripande statistik om organisationen — antal fakturor, hyresgäster, fastigheter, intäkter etc.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  {
    name: 'get_overdue_invoices',
    description: 'Hämtar alla förfallna fakturor med hyresgästinformation.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  {
    name: 'get_expiring_leases',
    description: 'Hämtar kontrakt som löper ut inom angivet antal dagar.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Antal dagar framåt, standard 90' },
      },
      required: [],
    },
  },

  {
    name: 'get_tenants',
    description: 'Hämtar lista över hyresgäster, kan filtreras på namn eller e-post.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Sökterm för namn eller e-post' },
      },
      required: [],
    },
  },

  {
    name: 'get_invoices',
    description: 'Hämtar fakturor, kan filtreras på status.',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'PARTIAL', 'VOID'],
          description: 'Filtrera på status',
        },
      },
      required: [],
    },
  },

  {
    name: 'get_properties',
    description: 'Hämtar alla fastigheter med antal enheter.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  {
    name: 'get_revenue_report',
    description: 'Hämtar intäktsrapport för angiven period.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Startdatum YYYY-MM-DD' },
        to: { type: 'string', description: 'Slutdatum YYYY-MM-DD' },
      },
      required: ['from', 'to'],
    },
  },

  // ── ACTION TOOLS (require confirmation) ──────────────────────────────────

  {
    name: 'create_invoice',
    description: 'Skapar en ny faktura för en hyresgäst. KRÄVER bekräftelse.',
    input_schema: {
      type: 'object',
      properties: {
        tenantId: { type: 'string', description: 'Hyresgästens ID' },
        tenantName: { type: 'string', description: 'Hyresgästens namn (för visning)' },
        type: { type: 'string', enum: ['RENT', 'DEPOSIT', 'SERVICE', 'UTILITY', 'OTHER'] },
        amount: { type: 'number', description: 'Belopp i SEK exkl. moms' },
        vatRate: { type: 'number', description: 'Momssats i procent, t.ex. 0 eller 25' },
        dueDate: { type: 'string', description: 'Förfallodatum YYYY-MM-DD' },
        description: { type: 'string', description: 'Fakturabeskrivning' },
      },
      required: ['tenantId', 'tenantName', 'type', 'amount', 'dueDate', 'description'],
    },
  },

  {
    name: 'create_bulk_invoices',
    description: 'Skapar hyresfakturor för alla aktiva kontrakt en viss månad. KRÄVER bekräftelse.',
    input_schema: {
      type: 'object',
      properties: {
        month: { type: 'number', description: 'Månad 1-12' },
        year: { type: 'number', description: 'År t.ex. 2026' },
        vatRate: { type: 'number', description: 'Momssats, standard 0' },
      },
      required: ['month', 'year'],
    },
  },

  {
    name: 'create_tenant',
    description: 'Skapar en ny hyresgäst. KRÄVER bekräftelse.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['INDIVIDUAL', 'COMPANY'] },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        companyName: { type: 'string' },
        email: { type: 'string', description: 'E-postadress (obligatorisk)' },
        phone: { type: 'string' },
      },
      required: ['type', 'email'],
    },
  },

  {
    name: 'update_tenant',
    description: 'Uppdaterar en hyresgästs kontaktinformation. KRÄVER bekräftelse.',
    input_schema: {
      type: 'object',
      properties: {
        tenantId: { type: 'string' },
        tenantName: { type: 'string', description: 'Namn för visning' },
        email: { type: 'string' },
        phone: { type: 'string' },
      },
      required: ['tenantId', 'tenantName'],
    },
  },

  {
    name: 'send_invoice_email',
    description: 'Skickar en faktura via e-post till hyresgästen. KRÄVER bekräftelse.',
    input_schema: {
      type: 'object',
      properties: {
        invoiceId: { type: 'string' },
        invoiceNumber: { type: 'string', description: 'Fakturanummer för visning' },
        tenantEmail: { type: 'string', description: 'Mottagarens e-post' },
      },
      required: ['invoiceId', 'invoiceNumber', 'tenantEmail'],
    },
  },

  {
    name: 'send_overdue_reminders',
    description:
      'Skickar betalningspåminnelser till hyresgäster med förfallna fakturor. KRÄVER bekräftelse.',
    input_schema: {
      type: 'object',
      properties: {
        invoiceIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specifika faktura-ID:n, eller tomt för alla förfallna',
        },
      },
      required: [],
    },
  },

  {
    name: 'mark_invoice_paid',
    description: 'Markerar en faktura som betald. KRÄVER bekräftelse.',
    input_schema: {
      type: 'object',
      properties: {
        invoiceId: { type: 'string' },
        invoiceNumber: { type: 'string', description: 'För visning' },
        amount: { type: 'number', description: 'Betalt belopp' },
        paymentDate: { type: 'string', description: 'Betalningsdatum YYYY-MM-DD' },
      },
      required: ['invoiceId', 'invoiceNumber', 'amount'],
    },
  },

  {
    name: 'create_lease',
    description: 'Skapar ett nytt hyreskontrakt. KRÄVER bekräftelse.',
    input_schema: {
      type: 'object',
      properties: {
        tenantId: { type: 'string' },
        tenantName: { type: 'string', description: 'För visning' },
        unitId: { type: 'string' },
        unitName: { type: 'string', description: 'För visning' },
        monthlyRent: { type: 'number' },
        startDate: { type: 'string', description: 'YYYY-MM-DD' },
        endDate: { type: 'string', description: 'YYYY-MM-DD eller null för tillsvidare' },
      },
      required: ['tenantId', 'tenantName', 'unitId', 'unitName', 'monthlyRent', 'startDate'],
    },
  },

  {
    name: 'transition_lease_status',
    description: 'Aktiverar eller avslutar ett hyreskontrakt. KRÄVER bekräftelse.',
    input_schema: {
      type: 'object',
      properties: {
        leaseId: { type: 'string' },
        tenantName: { type: 'string', description: 'För visning' },
        newStatus: { type: 'string', enum: ['ACTIVE', 'TERMINATED'] },
        reason: { type: 'string', description: 'Anledning (valfritt)' },
      },
      required: ['leaseId', 'tenantName', 'newStatus'],
    },
  },

  {
    name: 'create_tenant_and_invoice',
    description:
      'Skapar en ny hyresgäst och en faktura i ett steg. Använd detta verktyg NÄR hyresgästen INTE finns i systemet. KRÄVER bekräftelse.',
    input_schema: {
      type: 'object',
      properties: {
        tenantType: { type: 'string', enum: ['INDIVIDUAL', 'COMPANY'] },
        tenantFirstName: { type: 'string', description: 'Förnamn (krävs för privatperson)' },
        tenantLastName: { type: 'string', description: 'Efternamn (krävs för privatperson)' },
        tenantCompanyName: { type: 'string', description: 'Företagsnamn (krävs för företag)' },
        tenantEmail: { type: 'string', description: 'E-postadress (obligatorisk)' },
        tenantPhone: { type: 'string' },
        type: { type: 'string', enum: ['RENT', 'DEPOSIT', 'SERVICE', 'UTILITY', 'OTHER'] },
        amount: { type: 'number', description: 'Belopp i SEK exkl. moms' },
        vatRate: { type: 'number', description: 'Momssats i procent, t.ex. 0 eller 25' },
        dueDate: { type: 'string', description: 'Förfallodatum YYYY-MM-DD' },
        description: { type: 'string', description: 'Fakturabeskrivning' },
      },
      required: ['tenantType', 'tenantEmail', 'amount', 'dueDate', 'description'],
    },
  },

  {
    name: 'create_property',
    description: 'Skapar en ny fastighet. KRÄVER bekräftelse.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        propertyDesignation: { type: 'string' },
        type: {
          type: 'string',
          enum: ['RESIDENTIAL', 'COMMERCIAL', 'MIXED', 'INDUSTRIAL', 'LAND'],
        },
        street: { type: 'string' },
        city: { type: 'string' },
        postalCode: { type: 'string' },
      },
      required: ['name', 'propertyDesignation', 'type', 'street', 'city', 'postalCode'],
    },
  },

  {
    name: 'create_unit',
    description: 'Skapar en ny enhet i en fastighet. KRÄVER bekräftelse.',
    input_schema: {
      type: 'object',
      properties: {
        propertyId: { type: 'string' },
        propertyName: { type: 'string', description: 'För visning' },
        name: { type: 'string' },
        unitNumber: { type: 'string' },
        type: {
          type: 'string',
          enum: ['APARTMENT', 'OFFICE', 'RETAIL', 'STORAGE', 'PARKING', 'OTHER'],
        },
        monthlyRent: { type: 'number' },
        area: { type: 'number' },
      },
      required: ['propertyId', 'propertyName', 'name', 'unitNumber', 'type', 'monthlyRent', 'area'],
    },
  },

  {
    name: 'export_sie4',
    description: 'Exporterar bokföringsdata som SIE4-fil för revisorn. KRÄVER bekräftelse.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Startdatum YYYY-MM-DD' },
        to: { type: 'string', description: 'Slutdatum YYYY-MM-DD' },
      },
      required: ['from', 'to'],
    },
  },

  {
    name: 'compose_and_send_email',
    description:
      'Skriver och skickar ett e-postbrev till en eller flera hyresgäster. Kan användas för hyreshöjningar, påminnelser, välkomstbrev, allmän kommunikation. KRÄVER bekräftelse.',
    input_schema: {
      type: 'object',
      properties: {
        tenantIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Lista med hyresgäst-ID:n att skicka till',
        },
        tenantNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Hyresgästernas namn för visning',
        },
        subject: { type: 'string', description: 'E-postämne' },
        body: {
          type: 'string',
          description: 'E-postens innehåll (ren text, radbrytningar bevaras)',
        },
        emailType: {
          type: 'string',
          enum: [
            'RENT_INCREASE',
            'REMINDER',
            'WELCOME',
            'TERMINATION_NOTICE',
            'GENERAL',
            'MAINTENANCE',
          ],
          description: 'Typ av e-post',
        },
      },
      required: ['tenantIds', 'subject', 'body', 'emailType'],
    },
  },

  // ── LEASE CREATION TOOLS ─────────────────────────────────────────────────

  {
    name: 'get_available_units',
    description:
      'Hämtar lediga enheter per fastighet med all info — hyra, storlek, våning, typ. Används när AI ska hjälpa skapa ett kontrakt.',
    input_schema: {
      type: 'object',
      properties: {
        propertyId: {
          type: 'string',
          description: 'Fastighets-ID eller tomt för alla fastigheter',
        },
        propertyName: {
          type: 'string',
          description: 'Fastighetens namn om ID saknas — används för sökning',
        },
      },
      required: [],
    },
  },

  {
    name: 'create_tenant_and_lease',
    description:
      'Skapar en ny hyresgäst och ett hyreskontrakt i ett steg. Används i kontraktsskapandeflödet. KRÄVER bekräftelse.',
    input_schema: {
      type: 'object',
      properties: {
        unitId: { type: 'string', description: 'Enhetens ID' },
        unitName: { type: 'string', description: 'Enhetens namn för visning' },
        propertyName: { type: 'string', description: 'Fastighetens namn för visning' },
        tenantType: { type: 'string', enum: ['INDIVIDUAL', 'COMPANY'] },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        companyName: { type: 'string' },
        personalNumber: { type: 'string', description: 'Personnummer' },
        email: { type: 'string' },
        phone: { type: 'string' },
        monthlyRent: { type: 'number' },
        depositAmount: { type: 'number', description: 'Standard 0' },
        startDate: { type: 'string', description: 'YYYY-MM-DD' },
        endDate: { type: 'string', description: 'YYYY-MM-DD eller null' },
      },
      required: [
        'unitId',
        'unitName',
        'propertyName',
        'tenantType',
        'email',
        'monthlyRent',
        'startDate',
      ],
    },
  },

  // ── RENT INCREASE TOOLS ──────────────────────────────────────────────────

  {
    name: 'calculate_rent_increases',
    description:
      'Beräknar KPI-baserade hyreshöjningar för alla aktiva kontrakt. Visar nuvarande och ny hyra per hyresgäst.',
    input_schema: {
      type: 'object',
      properties: {
        kpiChangePercent: {
          type: 'number',
          description: 'KPI-förändring i procent, t.ex. 2.5 för 2,5% ökning',
        },
        effectiveDate: {
          type: 'string',
          description: 'Datum när höjningen gäller från YYYY-MM-DD',
        },
        applyToAll: {
          type: 'boolean',
          description: 'Tillämpa på alla aktiva kontrakt, standard false (bara beräkna)',
        },
      },
      required: ['kpiChangePercent', 'effectiveDate'],
    },
  },

  {
    name: 'apply_rent_increase',
    description:
      'Tillämpar en beräknad hyreshöjning på ett specifikt kontrakt. KRÄVER bekräftelse.',
    input_schema: {
      type: 'object',
      properties: {
        leaseId: { type: 'string' },
        tenantName: { type: 'string', description: 'För visning' },
        currentRent: { type: 'number' },
        newRent: { type: 'number' },
        effectiveDate: { type: 'string', description: 'YYYY-MM-DD' },
        sendNotification: {
          type: 'boolean',
          description: 'Skicka hyreshöjningsbrev till hyresgästen',
        },
      },
      required: ['leaseId', 'tenantName', 'currentRent', 'newRent', 'effectiveDate'],
    },
  },

  {
    name: 'generate_lease_contract',
    description:
      'Genererar ett komplett hyreskontrakt som PDF baserat på hyresgäst och enhet. Kontraktet följer svensk hyreslag.',
    input_schema: {
      type: 'object',
      properties: {
        leaseId: { type: 'string', description: 'ID för befintligt kontrakt' },
        tenantName: { type: 'string', description: 'För visning' },
        contractType: {
          type: 'string',
          enum: ['RESIDENTIAL', 'COMMERCIAL'],
          description: 'Bostads- eller lokalkontrakt',
        },
      },
      required: ['leaseId', 'tenantName', 'contractType'],
    },
  },

  // ── ANALYSIS TOOLS (read-only, no confirmation needed) ───────────────────

  {
    name: 'analyze_payment_behavior',
    description:
      'Analyserar betalningsbeteende per hyresgäst — hur ofta de betalar sent, genomsnittlig betalningstid etc.',
    input_schema: {
      type: 'object',
      properties: {
        tenantId: { type: 'string', description: 'Specifik hyresgäst eller tomt för alla' },
      },
      required: [],
    },
  },

  {
    name: 'compare_revenue',
    description: 'Jämför intäkter mellan perioder — månader, kvartal eller år.',
    input_schema: {
      type: 'object',
      properties: {
        period1From: { type: 'string', description: 'Period 1 startdatum YYYY-MM-DD' },
        period1To: { type: 'string', description: 'Period 1 slutdatum YYYY-MM-DD' },
        period2From: { type: 'string', description: 'Period 2 startdatum YYYY-MM-DD' },
        period2To: { type: 'string', description: 'Period 2 slutdatum YYYY-MM-DD' },
      },
      required: ['period1From', 'period1To', 'period2From', 'period2To'],
    },
  },

  {
    name: 'predict_cashflow',
    description: 'Förutsäger kassaflöde för kommande månader baserat på aktiva kontrakt.',
    input_schema: {
      type: 'object',
      properties: {
        months: { type: 'number', description: 'Antal månader framåt, standard 3' },
      },
      required: [],
    },
  },

  {
    name: 'find_optimization_opportunities',
    description:
      'Hittar möjligheter att optimera portföljen — enheter med låg hyra, kontrakt utan indexklausul etc.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
]

export const ACTION_TOOLS = new Set([
  'create_invoice',
  'create_bulk_invoices',
  'create_tenant',
  'create_tenant_and_invoice',
  'update_tenant',
  'send_invoice_email',
  'send_overdue_reminders',
  'mark_invoice_paid',
  'create_lease',
  'transition_lease_status',
  'create_property',
  'create_unit',
  'export_sie4',
  'compose_and_send_email',
  'apply_rent_increase',
  'generate_lease_contract',
  'create_tenant_and_lease',
])
