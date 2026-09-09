"""Builds text from immutable git objects; never writes any production path."""
import difflib
import hashlib
import json
import subprocess
from pathlib import Path

ROOT=Path(__file__).resolve().parents[4];HERE=Path(__file__).resolve().parent
OUT=ROOT/'docs/eval/bankhandelse-forslag';BASE='fa15d0d9f3eae17d04afc4d46165cb45205373fa'
changes={};old={}
def read(path):
    text=subprocess.check_output(['git','show',BASE+':'+path],cwd=ROOT,text=True)
    old[path]=text;return text
def replace(text,a,b,count=1):
    assert text.count(a)==count,(a[:120],text.count(a),count)
    return text.replace(a,b)
def part(text,start,end,new):
    a=text.index(start);b=text.index(end,a);return text[:a]+new+text[b:]
def save(path,text):changes[path]=text
P='apps/api/src/reconciliation/reconciliation.service.ts';s=read(P)
s="import { ingestIdentity, identityAllowed, identitySummary, identityObservations, blockedBankIds, lockIdentity, type BankOrigin, type IdentityImportResult } from './bank-event-gate'\n"+s
s=replace(s,'  duplicates: number\n','  duplicates: number\n  identityHeld?: number\n  resumed?: number\n',1)
s=replace(s,"  dedup: Prisma.BankTransactionWhereInput", "  // Compatibility input only: similarity is NOT identity evidence.\n  dedup: Prisma.BankTransactionWhereInput\n  // Reserved server adapter metadata; never exposed in the upload DTO.\n  identity?: { origin: BankOrigin; externalId: string }")
s=part(s,'export type FileIngestResult =','/**\n * PSD2 P1', '''export type FileIngestResult =
  | { held: true; reason: string; observationId: string }
  | { held?: false; duplicate: true }
  | { held?: false; duplicate: false; resumed: boolean; transactionId: string; matched: boolean; matchError?: Error }

''')
a=s.index('export type ApiIngestResult =');b=s.index('\n\n',a);s=s[:a]+'export type ApiIngestResult = IdentityImportResult'+s[b:]
s=part(s,'  async ingestFromFile(', '  // ── Parse CSV', '''  async ingestFromFile(organizationId: string, input: FileIngestInput): Promise<FileIngestResult> {
    const data = input.data
    const result = await ingestIdentity(this.prisma, organizationId, input.identity?.origin,
      input.identity?.externalId ?? null, {
        amountOre: new Decimal(data.amount.toString()).mul(100).toNumber(),
        day: normalizeToStockholmDay(new Date(data.date)).toISOString().slice(0, 10),
        booked: true, currency: 'SEK', description: data.description,
        rawOcr: data.rawOcr ?? null, reference: data.reference ?? null,
        ...(data.balance != null ? { balance: data.balance.toString() } : {}),
        originalFileFields: data,
      }, async tx => {
        const matched = await this.matchTransaction(tx, organizationId)
        if (!matched) await this.köaSkuggförslag(organizationId, tx.id)
        return matched
      })
    if (result.outcome === 'held' || result.outcome === 'rejected') {
      return { held: true, reason: result.reason, observationId: result.observationId }
    }
    if (result.outcome === 'duplicate') return { duplicate: true }
    return { duplicate: false, resumed: result.outcome === 'resumed', transactionId: result.transactionId, matched: result.matched }
  }

  async ingestFromApi(
    organizationId: string, externalId: string, raw: ApiRawTransaction, origin?: BankOrigin,
  ): Promise<ApiIngestResult> {
    const date = normalizeToStockholmDay(raw.bookingDate)
    const rawOcr = raw.ocr ?? extractOcr(raw.reference) ?? extractOcrFromProse(raw.description) ?? null
    return ingestIdentity(this.prisma, organizationId, origin, externalId, {
      amountOre: new Decimal(raw.amount).mul(100).toNumber(),
      day: date.toISOString().slice(0, 10), booked: raw.booked, currency: raw.currency,
      rawOcr, reference: raw.reference ?? null, description: raw.description,
      originalApiFields: raw,
    }, async tx => {
      const matched = await this.matchTransaction(tx, organizationId)
      if (!matched) await this.köaSkuggförslag(organizationId, tx.id)
      return matched
    })
  }

''')
s=replace(s,'        if (outcome.duplicate) {', '''        if (outcome.held) {
          result.identityHeld = (result.identityHeld ?? 0) + 1
          result.errors.push(`Bankidentitet kräver granskning: ${outcome.reason}, observation ${outcome.observationId}`)
          continue
        }
        if (outcome.duplicate) {''',2)
s=replace(s,'        result.imported++','''        if (outcome.resumed) result.resumed = (result.resumed ?? 0) + 1
        else result.imported++''',2)
s=replace(s,'if (result.imported === 0 && result.duplicates === 0)', 'if (result.imported === 0 && result.duplicates === 0 && !result.identityHeld && !result.resumed)')
s=replace(s,'    const db = prismaClient ?? this.prisma\n    const tolerance', '''    const db = prismaClient ?? this.prisma
    if (!await identityAllowed(db, organizationId, transaction.id)) {
      throw new BadRequestException('Bankidentitet eller tidigare hanteringsförsök kräver granskning')
    }
    const tolerance''')
# Gates INSIDE both monetary allocation transactions, not just a precheck.
needle='      await tx.$queryRaw`SELECT id FROM "BankTransaction" WHERE id = ${transactionId} AND "organizationId" = ${organizationId} FOR UPDATE`'
assert s.count(needle)==4
# Four include reversal paths. Do not block a needed explicit reversal: restrict
# insertion to the two allocation kernels, whose ranges end at the next method.
for begin,end in [('  private async applyMatchToInvoice(', '  private async applyMatchToRentNotice('),('  private async applyMatchToRentNotice(', '  // ── List')]:
    # End marker for the second range is resolved by method boundary below.
    a=s.index(begin);b=s.index('  async getTransactions(',a) if 'RentNotice' in begin else s.index(end,a)
    chunk=s[a:b];assert chunk.count(needle)==1
    s=s[:a]+chunk.replace(needle,'      await lockIdentity(tx, organizationId, transactionId)\n'+needle)+s[b:]
s=replace(s,'    return stats\n', '    return { ...stats, bankIdentity: await identitySummary(this.prisma, organizationId) }\n')
s=replace(s,'''  async autoMatchAll(organizationId: string): Promise<AutoMatchResult> {
    const candidates''','''  async autoMatchAll(organizationId: string): Promise<AutoMatchResult> {
    const identityBlocked = await blockedBankIds(this.prisma, organizationId)
    const candidates''')
a=s.index('  async autoMatchAll(');b=s.index('      orderBy:',a);chunk=s[a:b];chunk=replace(chunk,"        status: 'UNMATCHED',","        status: 'UNMATCHED',\n        id: { notIn: identityBlocked },");s=s[:a]+chunk+s[b:]
s=replace(s,'  async getStats(organizationId: string)', '''  async getIdentityObservations(organizationId: string, after?: string) {
    return identityObservations(this.prisma, organizationId, after)
  }

  async getStats(organizationId: string)''')
save(P,s)
P='apps/api/src/reconciliation/reconciliation.controller.ts';s=read(P)
s=replace(s,"  @Post('import')",'''  @Get('bank-observations')
  @Roles('ACCOUNTANT', 'MANAGER', 'ADMIN', 'OWNER')
  getBankObservations(@OrgId() organizationId: string, @Query('after') after?: string) {
    return this.reconciliationService.getIdentityObservations(organizationId, after)
  }

  @Post('import')''');save(P,s)
P='apps/api/src/reconciliation/bank-statement-import.service.ts';s=read(P)
s=replace(s,'export interface ImportCommitResult {', 'export interface ImportCommitResult {\n  identityHeld: number\n  identityObservations: string[]\n  resumed: number')
s=replace(s,'    let duplicates = 0','    let duplicates = 0\n    let identityHeld = 0\n    let resumed = 0\n    const identityObservations: string[] = []')
s=replace(s,'      if (outcome.duplicate) {','''      if (outcome.held) {
        identityHeld++
        identityObservations.push(outcome.observationId)
        continue
      }
      if (outcome.duplicate) {''')
s=replace(s,'      created++','      if (outcome.resumed) resumed++\n      else created++')
s=replace(s,'confirmedData: { transactions: finalTx }','confirmedData: { transactions: finalTx, identityHeld, identityObservations, resumed }')
s=replace(s,'return { importId: id, created, duplicates, autoMatched, unmatched }','return { importId: id, created, duplicates, autoMatched, unmatched, identityHeld, identityObservations, resumed }')
save(P,s)
P='apps/api/src/psd2/psd2-sync.service.ts';s=read(P)
s="import type { BankOrigin } from '../reconciliation/bank-event-gate'\n"+s
s=replace(s,'  rejected: number','  rejected: number\n  identityHeld: number\n  resumed: number')
s=replace(s,'      rejected: 0,','      rejected: 0,\n      identityHeld: 0,\n      resumed: 0,')
s=replace(s,'const rawTxs: ProviderRawTx[] = []','const rawTxs: Array<{ transaction: ProviderRawTx; origin: BankOrigin }> = []')
s=replace(s,'        rawTxs.push(...page.transactions)', '''        rawTxs.push(...page.transactions.map(transaction => ({ transaction, origin: {
          kind: 'api' as const, provider: this.provider.name, consent: consent.consentId, account: account.accountId,
        } })))''')
s=replace(s,'for (const tx of rawTxs)', 'for (const { transaction: tx, origin } of rawTxs)')
s=replace(s,'          this.toApiRaw(tx),','          this.toApiRaw(tx),\n          origin,')
s=replace(s,"        } else {\n          result.rejected++", "        } else if (outcome.outcome === 'held') {\n          result.identityHeld++\n        } else if (outcome.outcome === 'resumed') {\n          result.resumed++\n        } else {\n          result.rejected++")
s=replace(s,"        unmatchedCount: result.imported - result.matched,", "        unmatchedCount: result.imported - result.matched,\n        confirmedData: { identityHeld: result.identityHeld, resumed: result.resumed, fetched: result.fetched, rejected: result.rejected, duplicates: result.duplicates },")
save(P,s)
P='apps/api/src/ai/shadow/shadow-sweep.service.ts';s=read(P)
s="import { blockedBankIds } from '../../reconciliation/bank-event-gate'\n"+s
s=replace(s,"      const kandidater = await this.prisma.bankTransaction.count({", "      const identityBlocked = await blockedBankIds(this.prisma, org.id)\n      const kandidater = await this.prisma.bankTransaction.count({")
s=replace(s,"where: { organizationId: org.id, status: 'UNMATCHED', autoMatchExcludedAt: null }", "where: { organizationId: org.id, status: 'UNMATCHED', autoMatchExcludedAt: null, id: { notIn: identityBlocked } }",2);save(P,s)
P='apps/api/src/ai/shadow/payment/payment-shadow.service.ts';s=read(P)
s="import { identityAllowed } from '../../../reconciliation/bank-event-gate'\n"+s
s=replace(s,"    if (!tx) return { utfall: 'SAKNAS' }", "    if (!tx) return { utfall: 'SAKNAS' }\n    if (!await identityAllowed(this.prisma, organizationId, bankTransactionId)) {\n      return { utfall: 'INGEN_FRAGA', detalj: 'bankidentitet kräver granskning' }\n    }");save(P,s)
P='apps/api/src/payment-freshness/payment-freshness.service.ts';s=read(P)
s="import { identityOpen } from '../reconciliation/bank-event-gate'\n"+s
s=replace(s,'    return this.evaluate(org, now)','    const evaluation = this.evaluate(org, now)\n    return await identityOpen(this.prisma, organizationId) ? { ...evaluation, stale: true } : evaluation')
s=replace(s,'    const db = tx ?? this.prisma\n    const now', '    const db = tx ?? this.prisma\n    if (await identityOpen(db, organizationId)) return\n    const now')
s=replace(s,'    for (const org of orgs) {\n      const result', '''    for (const org of orgs) {
      if (await identityOpen(this.prisma, org.id)) {
        stale.add(org.id)
        this.logger.warn(`Bankidentitet/hanteringsförsök kräver granskning för org ${org.id}`)
        continue // Existing age-based email is not a truthful identity alert.
      }
      const result''');save(P,s)
P='apps/api/src/accounting/accounting-period.service.ts';s=read(P)
s="import { identityOpen } from '../reconciliation/bank-event-gate'\n"+s
s=replace(s,'      this.checkUnmatchedBankTransactions(organizationId, from, to),','      this.checkUnmatchedBankTransactions(organizationId, from, to),\n      this.checkBankIdentity(organizationId),')
s=replace(s,'  private async checkUnmatchedBankTransactions(', '''  private async checkBankIdentity(organizationId: string): Promise<PeriodCheck | null> {
    if (!await identityOpen(this.prisma, organizationId)) return null
    return { code: 'open-bank-identity', severity: 'blocking',
      message: 'Bankobservationer eller hanteringsförsök kräver granskning. Periodtillhörighet är inte styrkt.' }
  }

  private async checkUnmatchedBankTransactions(''');save(P,s)
P='apps/api/src/reconciliation/bank-event-gate.ts';old[P]='';save(P,(HERE/'bank-event-gate.ts.txt').read_text())
P='apps/api/prisma/migrations/20260909180000_bank_event_identity_proposal/migration.sql';old[P]='';save(P,(HERE/'storage.sql').read_text())
# Schema mapping supplied in a separate, reviewed template below.
P='apps/api/prisma/schema.prisma';s=read(P)
s=replace(s,'model Organization {','''model Organization {
  bankIdentityScopes BankIdentityScope[]
  bankImportGuard BankImportGuard?
  bankObservations BankObservation[]''')
s=replace(s,'model BankTransaction {','''model BankTransaction {
  identityEvent BankEvent?
  identityBridge BankIdentityBridge?
  @@unique([id, organizationId], map: "BankTransaction_id_org_identity_key")''')
s+='\n'+(HERE/'schema.prisma.txt').read_text();save(P,s)
patch=[];manifest={'base':BASE,'applied':False,'files':{}}
for path,new in changes.items():
    before=old[path];a='a/'+path if before else '/dev/null'
    patch.extend(difflib.unified_diff(before.splitlines(True),new.splitlines(True),fromfile=a,tofile='b/'+path))
    manifest['files'][path]={'baseSha256':hashlib.sha256(before.encode()).hexdigest() if before else None,
        'proposedSha256':hashlib.sha256(new.encode()).hexdigest(),'protected':path.startswith('apps/api/src/reconciliation/')}
raw=''.join(patch).encode();manifest['patchSha256']=hashlib.sha256(raw).hexdigest()
(OUT/'kandidat.patch').write_bytes(raw);(OUT/'kandidat-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('Wrote UNAPPLIED text proposal for',len(changes),'paths; no production files written.')
