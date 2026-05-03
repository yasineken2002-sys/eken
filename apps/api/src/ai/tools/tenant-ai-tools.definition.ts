import type Anthropic from '@anthropic-ai/sdk'

/**
 * Tools tillgängliga för hyresgäst-AI:n. Avsiktligt få och starkt avgränsade
 * — hyresgästen får ALDRIG fråga AI:n om annan hyresgästs data, andra
 * fastigheter eller verksamhetsledning.
 *
 * Alla read-tools tar inga organizationId/tenantId-parametrar — de scopas
 * automatiskt mot inloggad hyresgäst i TenantToolExecutorService.
 */
export const TENANT_TOOLS: Anthropic.Tool[] = [
  // ── READ TOOLS ───────────────────────────────────────────────────────────

  {
    name: 'get_my_lease',
    description:
      'Returnerar hyresgästens aktiva hyreskontrakt: enhet, månadshyra, startdatum, slutdatum, uppsägningstid, deposition och eventuell indexklausul.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  {
    name: 'get_my_invoices',
    description:
      'Returnerar hyresgästens fakturor och avier. Filtrera på status (DRAFT/SENT/PARTIAL/PAID/OVERDUE/VOID) och begränsa antalet.',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['DRAFT', 'SENT', 'PARTIAL', 'PAID', 'OVERDUE', 'VOID'],
          description: 'Filtrera på fakturastatus',
        },
        limit: { type: 'number', description: 'Max antal (default 20)' },
      },
      required: [],
    },
  },

  {
    name: 'get_my_payment_history',
    description:
      'Returnerar betalningshistorik (betalda fakturor) för hyresgästen. Kan filtreras på år.',
    input_schema: {
      type: 'object',
      properties: {
        year: { type: 'number', description: 'Filtrera på år (valfritt)' },
      },
      required: [],
    },
  },

  {
    name: 'get_my_documents',
    description:
      'Returnerar dokument kopplade till hyresgästen — t.ex. signerat hyreskontrakt, kvitton och bilagor (exklusive enskilda fakturor som hämtas via get_my_invoices).',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  {
    name: 'get_my_property_info',
    description:
      'Returnerar info om fastigheten där hyresgästen bor: adress, fastighetstyp och hyresvärdens kontaktuppgifter.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  {
    name: 'get_my_maintenance_tickets',
    description:
      'Returnerar hyresgästens egna felanmälningar med status (NEW/IN_PROGRESS/SCHEDULED/COMPLETED/CLOSED/CANCELLED).',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // ── ACTION TOOLS ─────────────────────────────────────────────────────────

  {
    name: 'create_maintenance_ticket',
    description:
      'Skapar en ny felanmälan kopplad till hyresgästens enhet. Skickar notis till fastighetsägaren. Kräver bekräftelse innan utskick.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Kort titel på felet' },
        description: { type: 'string', description: 'Detaljerad beskrivning' },
        category: {
          type: 'string',
          enum: ['PLUMBING', 'ELECTRICAL', 'HEATING', 'APPLIANCE', 'STRUCTURAL', 'PEST', 'OTHER'],
          description:
            'Kategori — VVS (PLUMBING), El (ELECTRICAL), Värme (HEATING), Vitvaror (APPLIANCE), Byggnad (STRUCTURAL), Skadedjur (PEST), Övrigt (OTHER)',
        },
        priority: {
          type: 'string',
          enum: ['LOW', 'NORMAL', 'HIGH', 'URGENT'],
          description: 'URGENT endast för akut (vatten/brand/el)',
        },
      },
      required: ['title', 'description'],
    },
  },

  {
    name: 'request_termination',
    description:
      'Skickar en BEGÄRAN om uppsägning av kontraktet till fastighetsägaren. Bekräftas av fastighetsägaren — AI:n kan aldrig själv acceptera uppsägningar. Skapar en TerminationRequest och skickar notis.',
    input_schema: {
      type: 'object',
      properties: {
        requestedEndDate: {
          type: 'string',
          description: 'Önskat avflyttningsdatum (YYYY-MM-DD)',
        },
        reason: {
          type: 'string',
          description: 'Anledning till uppsägning (valfritt men hjälper hyresvärden)',
        },
      },
      required: ['requestedEndDate'],
    },
  },
]

export const TENANT_ACTION_TOOLS = new Set(['create_maintenance_ticket', 'request_termination'])
