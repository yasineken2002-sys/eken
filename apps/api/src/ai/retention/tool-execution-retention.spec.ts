/**
 * Håller gallringshinkarna mot verktygsdefinitionen.
 *
 * Hinkindelningen är en uppräkning som ska spegla `ai-tools.definition.ts`.
 * Den sortens vakt slutar mäta utan att sluta vara grön: lägger någon till ett
 * verktyg utan att klassa det hamnar det tyst i den KORTASTE hinken (90 dagar),
 * eftersom `bucketForTool` är fail-open. För PII är det rätt håll; för ett nytt
 * bokföringsverktyg är det fel — då gallras det enda spåret av att AI:n rörde
 * bokföringen efter tre månader.
 *
 * Därför krävs uttrycklig klassning, och därför finns kanariefåglar.
 */

import {
  ACCOUNTING_TOOLS,
  ACCOUNTING_TOOL_RETENTION_DAYS,
  ACTION_TOOL_RETENTION_DAYS,
  READ_TOOL_RETENTION_DAYS,
  allToolNames,
  bucketForTool,
  nonReadToolNames,
  retentionDaysForBucket,
} from './tool-execution-retention'
import { ACCOUNTING_ONLY_ACTIONS, ACTION_TOOLS } from '../tools/ai-tools.definition'

describe('hinkarna speglar verktygsdefinitionen', () => {
  it('parsern ser fortfarande verktygen (rimlighetsgolv)', () => {
    // Utan detta kan `allToolNames()` returnera tomt och varje test nedan bli
    // grönt genom att inte mäta något.
    expect(allToolNames().length).toBeGreaterThan(40)
    expect(allToolNames()).toContain('create_journal_entry')
  })

  it('varje verktyg i ACCOUNTING_ONLY_ACTIONS hamnar i bokföringshinken', () => {
    for (const name of ACCOUNTING_ONLY_ACTIONS) {
      expect(bucketForTool(name as string)).toBe('accounting')
    }
  })

  it('varje ACTION_TOOL hamnar i action ELLER accounting — aldrig i läs-hinken', () => {
    // Ett handlingsverktyg som klassas som "läsande" skulle få 90 dagar. Det är
    // den mest sannolika felklassningen, och den syns inte i något annat test.
    for (const name of ACTION_TOOLS) {
      expect(['accounting', 'action']).toContain(bucketForTool(name as string))
    }
  })

  it('inget verktyg i ACCOUNTING_TOOLS saknas i definitionen', () => {
    const known = new Set(allToolNames())
    const spöken = [...ACCOUNTING_TOOLS].filter((name) => !known.has(name))
    expect(spöken).toEqual([])
  })

  it('fristerna är ordnade: bokföring > handling > läsning', () => {
    expect(ACCOUNTING_TOOL_RETENTION_DAYS).toBeGreaterThan(ACTION_TOOL_RETENTION_DAYS)
    expect(ACTION_TOOL_RETENTION_DAYS).toBeGreaterThan(READ_TOOL_RETENTION_DAYS)
    expect(retentionDaysForBucket('accounting')).toBe(ACCOUNTING_TOOL_RETENTION_DAYS)
    expect(retentionDaysForBucket('read')).toBe(READ_TOOL_RETENTION_DAYS)
  })

  it('läs-hinken är komplementet, inte en egen lista', () => {
    // Ett borttaget verktyg får inte bli odödligt. `nonReadToolNames` används
    // som `notIn`, så allt okänt fångas av den kortaste fristen.
    const nonRead = nonReadToolNames()
    expect(nonRead).toContain('create_journal_entry')
    expect(nonRead).not.toContain('ett_verktyg_som_inte_finns')
    expect(bucketForTool('ett_verktyg_som_togs_bort_2025')).toBe('read')
  })
})

describe('KANARIEFÅGEL — klassningen faller när ett verktyg inte är klassat', () => {
  it('ett oklassat handlingsverktyg hamnar i kortaste hinken', () => {
    // Sonden heter något som bevisligen inte finns.
    expect(allToolNames()).not.toContain('gdpr_canary_action_tool')

    // Så här ser felet ut: verktyget finns i ACTION_TOOLS men ingen har lagt
    // det i ACCOUNTING_TOOLS, och det är inte heller känt av definitionen.
    expect(bucketForTool('gdpr_canary_action_tool')).toBe('read')
    expect(retentionDaysForBucket(bucketForTool('gdpr_canary_action_tool'))).toBe(
      READ_TOOL_RETENTION_DAYS,
    )

    // Och det är precis därför testet ovan kräver att VARJE medlem i
    // ACTION_TOOLS klassas uttryckligen: fail-open syns inte annars.
    const injected = new Set([...ACTION_TOOLS, 'gdpr_canary_action_tool'])
    const felklassade = [...injected].filter(
      (name) => !['accounting', 'action'].includes(bucketForTool(name as string)),
    )
    expect(felklassade).toEqual(['gdpr_canary_action_tool'])
  })
})
