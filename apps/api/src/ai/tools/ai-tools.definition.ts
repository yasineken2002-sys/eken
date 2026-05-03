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

  // ── MAINTENANCE TOOLS ────────────────────────────────────────────────────

  {
    name: 'get_maintenance_tickets',
    description: 'Hämtar underhållsärenden — kan filtreras på status, prioritet eller fastighet.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'NEW, IN_PROGRESS, SCHEDULED, COMPLETED, CLOSED' },
        priority: { type: 'string', description: 'LOW, NORMAL, HIGH, URGENT' },
        propertyId: { type: 'string' },
      },
      required: [],
    },
  },

  {
    name: 'create_maintenance_ticket',
    description: 'Skapar ett nytt underhållsärende/felanmälan. KRÄVER bekräftelse.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        propertyId: { type: 'string' },
        propertyName: { type: 'string' },
        unitId: { type: 'string' },
        unitName: { type: 'string' },
        category: { type: 'string' },
        priority: { type: 'string', enum: ['LOW', 'NORMAL', 'HIGH', 'URGENT'] },
        estimatedCost: { type: 'number' },
      },
      required: ['title', 'description', 'propertyId', 'propertyName'],
    },
  },

  {
    name: 'update_maintenance_status',
    description: 'Uppdaterar status på ett underhållsärende. KRÄVER bekräftelse.',
    input_schema: {
      type: 'object',
      properties: {
        ticketId: { type: 'string' },
        ticketNumber: { type: 'string' },
        newStatus: {
          type: 'string',
          enum: ['IN_PROGRESS', 'SCHEDULED', 'COMPLETED', 'CLOSED', 'CANCELLED'],
        },
        comment: { type: 'string', description: 'Valfri kommentar om åtgärden' },
      },
      required: ['ticketId', 'ticketNumber', 'newStatus'],
    },
  },

  // ── INSPECTION TOOLS ────────────────────────────────────────────────────

  {
    name: 'get_inspections',
    description: 'Hämtar besiktningar — kan filtreras på typ, status och enhet.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'MOVE_IN, MOVE_OUT, PERIODIC, DAMAGE' },
        status: { type: 'string', description: 'SCHEDULED, IN_PROGRESS, COMPLETED, SIGNED' },
        unitId: { type: 'string', description: 'Filtrera på enhet' },
      },
      required: [],
    },
  },

  {
    name: 'create_inspection',
    description: 'Skapar en ny besiktning för en enhet. KRÄVER bekräftelse.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['MOVE_IN', 'MOVE_OUT', 'PERIODIC', 'DAMAGE'] },
        propertyId: { type: 'string' },
        propertyName: { type: 'string', description: 'För visning' },
        unitId: { type: 'string' },
        unitName: { type: 'string', description: 'För visning' },
        tenantId: { type: 'string' },
        tenantName: { type: 'string', description: 'För visning' },
        scheduledDate: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['type', 'propertyId', 'propertyName', 'unitId', 'unitName', 'scheduledDate'],
    },
  },

  // ── AVISERING TOOLS ─────────────────────────────────────────────────────

  {
    name: 'get_rent_notices',
    description: 'Hämtar hyresavier — kan filtreras på månad, år och status.',
    input_schema: {
      type: 'object',
      properties: {
        month: { type: 'number', description: 'Månad 1-12' },
        year: { type: 'number', description: 'År t.ex. 2026' },
        status: { type: 'string', description: 'PENDING, SENT, PAID, OVERDUE, CANCELLED' },
      },
      required: [],
    },
  },

  {
    name: 'generate_rent_notices',
    description: 'Genererar hyresavier för alla aktiva kontrakt en viss månad. KRÄVER bekräftelse.',
    input_schema: {
      type: 'object',
      properties: {
        month: { type: 'number', description: 'Månad 1-12' },
        year: { type: 'number', description: 'År t.ex. 2026' },
      },
      required: ['month', 'year'],
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
    name: 'get_maintenance_plan',
    description: 'Hämtar underhållsplanen — planerade åtgärder och kostnader per år.',
    input_schema: {
      type: 'object',
      properties: {
        fromYear: { type: 'number', description: 'Från år (default innevarande)' },
        toYear: { type: 'number', description: 'Till år (default +5)' },
        propertyId: { type: 'string', description: 'Filtrera på specifik fastighet' },
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

  // ── BANKAVSTÄMNING — READ ──────────────────────────────────────────────────

  {
    name: 'get_bank_transactions',
    description:
      'Hämtar banktransaktioner med filter på status (UNMATCHED/MATCHED/IGNORED), datumintervall och antal.',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['UNMATCHED', 'MATCHED', 'IGNORED'],
          description: 'Matchningsstatus',
        },
        fromDate: { type: 'string', description: 'Från-datum (YYYY-MM-DD)' },
        toDate: { type: 'string', description: 'Till-datum (YYYY-MM-DD)' },
        limit: { type: 'number', description: 'Max antal rader (default 50)' },
      },
      required: [],
    },
  },

  {
    name: 'get_unmatched_transactions',
    description:
      'Hämtar alla banktransaktioner som ännu inte matchats mot en faktura. Använd som första steg vid bankavstämning.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  {
    name: 'get_reconciliation_summary',
    description:
      'Returnerar avstämningssammanfattning: antal matchade/omatchade transaktioner, totalbelopp och andel automatiskt matchat.',
    input_schema: {
      type: 'object',
      properties: {
        month: { type: 'number', description: 'Månad 1–12 (valfritt)' },
        year: { type: 'number', description: 'År (valfritt)' },
      },
      required: [],
    },
  },

  // ── BANKAVSTÄMNING — ACTION ────────────────────────────────────────────────

  {
    name: 'match_bank_transaction',
    description:
      'Matchar manuellt en banktransaktion mot en specifik faktura. Bokför betalningen via 1930→1510 och markerar fakturan som PAID.',
    input_schema: {
      type: 'object',
      properties: {
        transactionId: { type: 'string', description: 'BankTransaction-ID' },
        invoiceId: { type: 'string', description: 'Faktura-ID' },
      },
      required: ['transactionId', 'invoiceId'],
    },
  },

  {
    name: 'import_bgmax_file',
    description:
      'Importerar en BgMax-fil (Bankgirot-format) — parsar betalningsposter, skapar bankrader och auto-matchar mot fakturor via OCR. Returnerar summering med antal matchade/omatchade.',
    input_schema: {
      type: 'object',
      properties: {
        fileContent: { type: 'string', description: 'Filinnehåll i base64' },
        fileName: { type: 'string', description: 'Filnamn (för loggning)' },
      },
      required: ['fileContent', 'fileName'],
    },
  },

  {
    name: 'unmatch_transaction',
    description:
      'Ångrar en felaktig matchning. Återställer fakturans status till SENT/OVERDUE och skapar korrigerings-verifikat (motverifikat) i bokföringen. Kräver dubbelbekräftelse om matchningen är äldre än 30 dagar.',
    input_schema: {
      type: 'object',
      properties: {
        transactionId: { type: 'string', description: 'BankTransaction-ID' },
        reason: { type: 'string', description: 'Anledning till avmatchning (för audit)' },
      },
      required: ['transactionId', 'reason'],
    },
  },

  // ── BOKFÖRING — READ ──────────────────────────────────────────────────────

  {
    name: 'get_journal_entries',
    description: 'Hämtar verifikat med rader, filtrerat på datum och eventuellt kontonummer.',
    input_schema: {
      type: 'object',
      properties: {
        fromDate: { type: 'string', description: 'Från-datum (YYYY-MM-DD)' },
        toDate: { type: 'string', description: 'Till-datum (YYYY-MM-DD)' },
        accountNumber: { type: 'number', description: 'Filtrera på BAS-konto (t.ex. 1930)' },
      },
      required: [],
    },
  },

  {
    name: 'get_account_balance',
    description:
      'Returnerar saldo på ett BAS-konto vid ett datum. Saldo = sum(debet) − sum(kredit) över alla journalposter på kontot t.o.m. asOfDate.',
    input_schema: {
      type: 'object',
      properties: {
        accountNumber: { type: 'number', description: 'BAS-kontonummer (t.ex. 1930)' },
        asOfDate: { type: 'string', description: 'Per-datum (YYYY-MM-DD), default idag' },
      },
      required: ['accountNumber'],
    },
  },

  {
    name: 'get_vat_report',
    description:
      'Genererar momsrapport för en period: utgående moms (2611/2621/2631), ingående moms (2641) och nettomoms att betala/få tillbaka. Underlag för Skatteverket-deklaration.',
    input_schema: {
      type: 'object',
      properties: {
        fromDate: { type: 'string', description: 'Från-datum (YYYY-MM-DD)' },
        toDate: { type: 'string', description: 'Till-datum (YYYY-MM-DD)' },
      },
      required: ['fromDate', 'toDate'],
    },
  },

  {
    name: 'get_profit_loss_report',
    description:
      'Resultaträkning per period: intäkter (3xxx), driftkostnader (5xxx), administrativa (6xxx), personal (7xxx), avskrivningar (8xxx). Kan filtreras per fastighet (preliminärt — kräver att kostnaderna är taggade).',
    input_schema: {
      type: 'object',
      properties: {
        fromDate: { type: 'string', description: 'Från-datum (YYYY-MM-DD)' },
        toDate: { type: 'string', description: 'Till-datum (YYYY-MM-DD)' },
        propertyId: { type: 'string', description: 'Filtrera på fastighet (valfritt)' },
      },
      required: ['fromDate', 'toDate'],
    },
  },

  {
    name: 'get_balance_sheet',
    description:
      'Balansräkning vid ett datum: tillgångar (1xxx), eget kapital + skulder (2xxx). Saldo per konto och summering.',
    input_schema: {
      type: 'object',
      properties: {
        asOfDate: { type: 'string', description: 'Per-datum (YYYY-MM-DD)' },
      },
      required: ['asOfDate'],
    },
  },

  // ── BOKFÖRING — ACTION ────────────────────────────────────────────────────

  {
    name: 'create_journal_entry',
    description:
      'Skapar ett manuellt verifikat (JournalEntry) med rader. Validerar att debet = kredit och att alla konton finns i BAS-kontoplanen. Kräver dubbelbekräftelse om summa > 100 000 kr.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Verifikationsdatum (YYYY-MM-DD)' },
        description: { type: 'string', description: 'Verifikationstext' },
        lines: {
          type: 'array',
          description: 'Verifikationsrader — debet och kredit måste balansera',
          items: {
            type: 'object',
            properties: {
              accountNumber: { type: 'number', description: 'BAS-kontonummer' },
              debit: { type: 'number', description: 'Debet-belopp (eller 0)' },
              credit: { type: 'number', description: 'Kredit-belopp (eller 0)' },
              description: { type: 'string', description: 'Radbeskrivning' },
            },
            required: ['accountNumber'],
          },
        },
      },
      required: ['date', 'description', 'lines'],
    },
  },

  {
    name: 'record_expense',
    description:
      'Bokför en utgift — debet på kostnadskonto (t.ex. 5070 Reparationer) och kredit på 1930 (Bank). Hanterar moms separat på 2641 om vatAmount anges.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Datum (YYYY-MM-DD)' },
        amount: { type: 'number', description: 'Total betalt belopp (inkl. moms)' },
        vatAmount: { type: 'number', description: 'Momsbelopp (valfritt)' },
        description: { type: 'string', description: 'Beskrivning av utgiften' },
        accountNumber: {
          type: 'number',
          description: 'Kostnadskonto (t.ex. 5070 Reparationer, 5080 Försäkring)',
        },
        propertyId: { type: 'string', description: 'Fastighets-ID (valfritt, för spårning)' },
      },
      required: ['date', 'amount', 'description', 'accountNumber'],
    },
  },

  {
    name: 'close_period',
    description:
      'Stänger en bokföringsperiod (månad/år) — efter detta kan inga nya verifikat skapas med datum inom perioden. Genererar periodrapport. Kräver ALLTID dubbelbekräftelse — kan inte återöppnas via API.',
    input_schema: {
      type: 'object',
      properties: {
        month: { type: 'number', description: 'Månad 1–12' },
        year: { type: 'number', description: 'År' },
      },
      required: ['month', 'year'],
    },
  },

  // ── PÅMINNELSER OCH INKASSO ─────────────────────────────────────────────

  {
    name: 'get_overdue_status',
    description:
      'Översikt över alla förfallna fakturor och deras påminnelse-status: hur många dagar förfallna, vilka påminnelser som skickats, om reminders är pausade, om fakturan är skickad till inkasso.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  {
    name: 'pause_reminders',
    description:
      'Pausar automatiska påminnelser för en specifik faktura. Använd vid avbetalningsplan eller pågående dialog med hyresgästen. Kräver bekräftelse.',
    input_schema: {
      type: 'object',
      properties: {
        invoiceId: { type: 'string', description: 'Faktura-ID' },
        invoiceNumber: { type: 'string', description: 'Fakturanummer (för bekräftelse-UI)' },
        reason: { type: 'string', description: 'Anledning till pausen (visas i audit-logg)' },
      },
      required: ['invoiceId', 'reason'],
    },
  },

  {
    name: 'resume_reminders',
    description:
      'Återupptar automatiska påminnelser för en pausad faktura. Påminnelseflödet räknar dagar sedan förfall, så nästa lämpliga påminnelse skickas vid nästa cron-körning.',
    input_schema: {
      type: 'object',
      properties: {
        invoiceId: { type: 'string', description: 'Faktura-ID' },
        invoiceNumber: { type: 'string', description: 'Fakturanummer (för bekräftelse-UI)' },
      },
      required: ['invoiceId'],
    },
  },

  {
    name: 'export_for_collection',
    description:
      'Genererar inkassounderlag (PDF + CSV) för en faktura och sparar i molnlagringen. Markerar fakturan som SENT_TO_COLLECTION och pausar automatiska påminnelser. Eveno bedriver INTE inkassoverksamhet — underlaget skickas av fastighetsägaren till valt inkassobolag (Visma Collectors, Intrum, Lindorff, etc.). Kräver bekräftelse.',
    input_schema: {
      type: 'object',
      properties: {
        invoiceId: { type: 'string', description: 'Faktura-ID' },
        invoiceNumber: { type: 'string', description: 'Fakturanummer (för bekräftelse-UI)' },
      },
      required: ['invoiceId'],
    },
  },

  {
    name: 'mark_sent_to_collection',
    description:
      'Manuell markering att fakturan har skickats till externt inkassobolag (om fastighetsägaren använt Vismas portal eller annat verktyg). Pausar påminnelser, sätter status till SENT_TO_COLLECTION.',
    input_schema: {
      type: 'object',
      properties: {
        invoiceId: { type: 'string', description: 'Faktura-ID' },
        invoiceNumber: { type: 'string', description: 'Fakturanummer (för bekräftelse-UI)' },
        note: { type: 'string', description: 'Valfri notering om vilket inkassobolag som används' },
      },
      required: ['invoiceId'],
    },
  },
]

export const ACTION_TOOLS = new Set([
  'create_maintenance_ticket',
  'update_maintenance_status',
  'create_invoice',
  'create_bulk_invoices',
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
  'generate_rent_notices',
  'create_inspection',
  // Bankavstämning + bokföring
  'match_bank_transaction',
  'import_bgmax_file',
  'unmatch_transaction',
  'create_journal_entry',
  'record_expense',
  'close_period',
  // Påminnelser och inkasso
  'pause_reminders',
  'resume_reminders',
  'export_for_collection',
  'mark_sent_to_collection',
])

// Bokförings-tools — endast ACCOUNTANT, ADMIN, OWNER. MANAGER blockeras.
export const ACCOUNTING_ONLY_ACTIONS = new Set([
  'create_journal_entry',
  'record_expense',
  'close_period',
  'unmatch_transaction',
  'export_for_collection',
  'mark_sent_to_collection',
])
