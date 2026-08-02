/**
 * R4.0 — AI-GRINDEN FRÅN DENY-BY-EXCEPTION TILL ALLOW-LIST.
 *
 * Grinden var en kedja av nekanden: VIEWER stoppades, MANAGER krävde whitelist,
 * två neka-listor täckte bokföring och förvaltning. En roll som inte var någon
 * av de fem föll igenom allt och landade i "tillåtet" — 14 av 30
 * handlingsverktyg, inklusive create_invoice, mark_invoice_paid och
 * match_bank_transaction.
 *
 * ── Varför ORAKLET ser ut som det gör ────────────────────────────────────────
 *
 * `gammalBeslut` nedan är den gamla kedjan ORDAGRANT, kopierad ur
 * tool-executor.service innan bytet — samma ordning, samma villkor, samma
 * meddelanden. Den finns här för att svara på den enda fråga som avgör om bytet
 * är säkert: säger den nya implementationen exakt samma sak som den gamla, för
 * varje verktyg och varje KÄND roll?
 *
 * Samma form som R2 steg 2:s ekvivalenstest (795 jämförelser genom båda
 * implementationerna). Det testet pensionerades när dess orakel — den
 * hierarkiska guarden — övergavs med flit. Det här oraklet ska pensioneras på
 * samma sätt den dag någon medvetet ändrar ett rollbeslut: då FAILAR testet,
 * och det är rätt beteende. Ett orakel man justerar för att få grönt är inget
 * orakel.
 */

import {
  ACTION_TOOLS,
  ACCOUNTING_ONLY_ACTIONS,
  MANAGEMENT_ONLY_ACTIONS,
  MANAGER_ALLOWED_ACTIONS,
} from '../../ai/tools/ai-tools.definition'
import { decideAiToolAccess, AI_TOOL_DENIAL_MESSAGES } from './ai-tool-authz'

const KÄNDA_ROLLER = ['OWNER', 'ADMIN', 'MANAGER', 'ACCOUNTANT', 'VIEWER'] as const

/** Den gamla kedjan, ordagrant. Returnerar nekandets meddelande, eller null. */
function gammaltBeslut(toolName: string, userRole: string): string | null {
  if (ACTION_TOOLS.has(toolName)) {
    if (userRole === 'VIEWER') {
      return 'Du har inte behörighet att utföra åtgärder.'
    }
    if (userRole === 'MANAGER' && !MANAGER_ALLOWED_ACTIONS.has(toolName)) {
      return 'Du har inte behörighet för denna åtgärd.'
    }
    if (ACCOUNTING_ONLY_ACTIONS.has(toolName)) {
      if (userRole !== 'ACCOUNTANT' && userRole !== 'ADMIN' && userRole !== 'OWNER') {
        return 'Endast bokförare (ACCOUNTANT) eller administratörer får använda bokförings-verktyg.'
      }
    }
    if (MANAGEMENT_ONLY_ACTIONS.has(toolName)) {
      if (userRole !== 'MANAGER' && userRole !== 'ADMIN' && userRole !== 'OWNER') {
        return 'Endast förvaltare (MANAGER) eller administratörer får använda förvaltnings-verktyg.'
      }
    }
    if (toolName === 'prepare_contract_signing' && userRole !== 'OWNER' && userRole !== 'ADMIN') {
      return 'Endast OWNER/ADMIN får förbereda en signering (bindande handling).'
    }
  }
  return null
}

/** Nya beslutet i samma form som oraklet, så de går att jämföra rakt av. */
function nyttBeslut(toolName: string, userRole: string): string | null {
  const d = decideAiToolAccess(toolName, userRole)
  return d.allowed ? null : d.reason
}

describe('R4.0 · AI-grindens rollbeslut', () => {
  const verktyg = [...ACTION_TOOLS].sort()

  it('riggen mäter en verklig yta (rimlighetsgolv)', () => {
    // Ett tomt ACTION_TOOLS hade gjort varje jämförelse nedan trivialt sann.
    expect(verktyg.length).toBeGreaterThanOrEqual(25)
  })

  describe('EKVIVALENS — noll beteendeändring för de fem kända rollerna', () => {
    it('varje verktyg × varje känd roll ger identiskt svar, meddelandet inräknat', () => {
      const avvikelser: string[] = []
      for (const tool of verktyg) {
        for (const roll of KÄNDA_ROLLER) {
          const gammalt = gammaltBeslut(tool, roll)
          const nytt = nyttBeslut(tool, roll)
          if (gammalt !== nytt) {
            avvikelser.push(
              `${tool} / ${roll}: gammalt=${gammalt ?? 'TILLÅTS'} nytt=${nytt ?? 'TILLÅTS'}`,
            )
          }
        }
      }
      expect(avvikelser).toEqual([])
    })

    it('jämförelsen omfattar hela ytan, inte ett stickprov', () => {
      // Utan den här kontrollen kunde testet ovan vara grönt för att slingan
      // aldrig kördes.
      expect(verktyg.length * KÄNDA_ROLLER.length).toBeGreaterThanOrEqual(125)
    })
  })

  describe('OKÄND ROLL — det som var hålet', () => {
    it.each(['REVISOR', 'FOO', 'owner', 'Admin', '', 'SUPERADMIN'])(
      '%s nekas SAMTLIGA handlingsverktyg',
      (roll) => {
        const insläppta = verktyg.filter((t) => nyttBeslut(t, roll) === null)
        expect(insläppta).toEqual([])
      },
    )

    it('nekandet har en egen formulering — inte en lånad från en annan roll', () => {
      // Sonden i behörighetsytan klassificerar på meddelandet. Återanvände vi
      // t.ex. VIEWER-texten hade en okänd roll sett ut som en VIEWER i
      // golden-filen, alltså rätt utfall av fel skäl.
      const d = decideAiToolAccess('create_invoice', 'REVISOR')
      expect(d).toEqual({ allowed: false, reason: AI_TOOL_DENIAL_MESSAGES.okändRoll })
    })

    it('och den GAMLA implementationen släppte in dem — hålet var verkligt', () => {
      // Regressionens motpol: visar att bytet faktiskt ändrade något, och exakt
      // vad. Faller den här raden har oraklet skrivits om i efterhand.
      const insläpptaFörr = verktyg.filter((t) => gammaltBeslut(t, 'REVISOR') === null)
      expect(insläpptaFörr.length).toBeGreaterThan(10)
      expect(insläpptaFörr).toContain('create_invoice')
      expect(insläpptaFörr).toContain('mark_invoice_paid')
      expect(insläpptaFörr).toContain('match_bank_transaction')
    })
  })

  describe('läsverktyg är fortsatt ogrindade', () => {
    it('ett verktyg utanför ACTION_TOOLS tillåts för alla roller', () => {
      // R1:s gräns: läsa är förvaltning. Den ändras inte av R4.0, och en
      // allow-list som råkat svälja läsytan hade brutit varje läsande verktyg.
      expect(ACTION_TOOLS.has('get_tenants')).toBe(false)
      for (const roll of [...KÄNDA_ROLLER, 'REVISOR']) {
        expect(decideAiToolAccess('get_tenants', roll)).toEqual({ allowed: true })
      }
    })
  })

  describe('MANAGER-grenens onåbara kontroller — bevis, inte avsikt', () => {
    /**
     * De två kontrollerna efter whitelisten i MANAGER-grenen kan inte triggas i
     * dag: MANAGER_ALLOWED_ACTIONS är disjunkt från ACCOUNTING_ONLY_ACTIONS och
     * innehåller inte prepare_contract_signing. Kommentaren i ai-tool-authz.ts
     * säger att de står kvar som skydd mot ett framtida tillägg i whitelisten.
     *
     * Det PÅSTÅENDET var otestat, vilket säkerhetsgranskningen påpekade. Testet
     * nedan simulerar just den framtida regressionen genom att tillfälligt lägga
     * verktyget i whitelisten — och visar att MANAGER ändå nekas, av rätt skäl.
     *
     * Mängderna muteras i testet, aldrig i produktionskoden, och återställs i
     * `finally` så ingen ordningsberoende läcka uppstår mellan testerna.
     */
    it('ett bokföringsverktyg som SMYGER IN i whitelisten nekas ändå', () => {
      const verktyg = [...ACCOUNTING_ONLY_ACTIONS][0]!
      expect(MANAGER_ALLOWED_ACTIONS.has(verktyg)).toBe(false) // utgångsläget
      MANAGER_ALLOWED_ACTIONS.add(verktyg)
      try {
        expect(decideAiToolAccess(verktyg, 'MANAGER')).toEqual({
          allowed: false,
          reason: AI_TOOL_DENIAL_MESSAGES.accounting,
        })
      } finally {
        MANAGER_ALLOWED_ACTIONS.delete(verktyg)
      }
      expect(MANAGER_ALLOWED_ACTIONS.has(verktyg)).toBe(false) // återställt
    })

    it('signeringsförberedelse i whitelisten nekas ändå', () => {
      expect(MANAGER_ALLOWED_ACTIONS.has('prepare_contract_signing')).toBe(false)
      MANAGER_ALLOWED_ACTIONS.add('prepare_contract_signing')
      try {
        expect(decideAiToolAccess('prepare_contract_signing', 'MANAGER')).toEqual({
          allowed: false,
          reason: AI_TOOL_DENIAL_MESSAGES.signing,
        })
      } finally {
        MANAGER_ALLOWED_ACTIONS.delete('prepare_contract_signing')
      }
      expect(MANAGER_ALLOWED_ACTIONS.has('prepare_contract_signing')).toBe(false)
    })
  })
})
