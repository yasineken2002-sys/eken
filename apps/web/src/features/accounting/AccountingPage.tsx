import { useState } from 'react'
import { motion } from 'framer-motion'
import { BookOpen, FileX, Database } from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/EmptyState'
import { StatCard } from '@/components/ui/StatCard'
import { formatCurrency, formatDate } from '@eken/shared'
import type { Account, JournalEntry, JournalEntryLine } from '@eken/shared'
import { cn } from '@/lib/cn'
import { useAccounts, useSeedAccounts, useJournalEntries } from './hooks/useAccounting'

type View = 'chart' | 'journal'

const accountTypeLabel: Record<string, string> = {
  ASSET: 'Tillgångar',
  LIABILITY: 'Skulder',
  EQUITY: 'Eget kapital',
  REVENUE: 'Intäkter',
  EXPENSE: 'Kostnader',
}

const accountTypeVariant: Record<string, 'success' | 'danger' | 'info' | 'warning' | 'default'> = {
  ASSET: 'success',
  LIABILITY: 'danger',
  EQUITY: 'default',
  REVENUE: 'info',
  EXPENSE: 'warning',
}

const sourceLabel: Record<string, string> = {
  INVOICE: 'Faktura',
  PAYMENT: 'Betalning',
  MANUAL: 'Manuell',
  LEASE: 'Kontrakt',
}

const sourceVariant: Record<string, 'info' | 'success' | 'default' | 'warning'> = {
  INVOICE: 'info',
  PAYMENT: 'success',
  MANUAL: 'default',
  LEASE: 'warning',
}

function AccountRow({ account, delay }: { account: Account; delay: number }) {
  const firstDigit = parseInt(account.number.toString()[0] ?? '5')
  const color =
    firstDigit === 1
      ? 'bg-emerald-50 text-emerald-700'
      : firstDigit === 2
        ? 'bg-red-50 text-red-700'
        : firstDigit === 3
          ? 'bg-blue-50 text-blue-700'
          : 'bg-amber-50 text-amber-700'
  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay }}
      className="flex items-center justify-between rounded-xl px-4 py-3 transition-colors hover:bg-gray-50"
    >
      <div className="flex items-center gap-3">
        <span className={`rounded-md px-2 py-0.5 font-mono text-[13px] font-bold ${color}`}>
          {account.number}
        </span>
        <span className="text-[13.5px] font-medium text-gray-800">{account.name}</span>
      </div>
      <Badge variant={accountTypeVariant[account.type] ?? 'default'}>
        {accountTypeLabel[account.type] ?? account.type}
      </Badge>
    </motion.div>
  )
}

function JournalEntryCard({
  entry,
  delay,
  onClick,
}: {
  entry: JournalEntry
  delay: number
  onClick: () => void
}) {
  const totalDebit = entry.lines.reduce((s, l) => s + (l.debit ?? 0), 0)
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay }}
      onClick={onClick}
      className="cursor-pointer overflow-hidden rounded-2xl border border-[#EAEDF0] bg-white transition-shadow hover:shadow-sm"
    >
      <div className="flex items-center justify-between border-b border-[#EAEDF0] px-5 py-3.5">
        <div>
          <p className="text-[14px] font-semibold text-gray-900">{entry.description}</p>
          <p className="mt-0.5 text-[12px] text-gray-400">
            {formatDate(entry.date)}
            {entry.reference ? ` · ${entry.reference}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {entry.source && (
            <Badge variant={sourceVariant[entry.source] ?? 'default'}>
              {sourceLabel[entry.source] ?? entry.source}
            </Badge>
          )}
          <div className="text-right">
            <p className="text-[13px] font-semibold text-gray-700">{formatCurrency(totalDebit)}</p>
            <p className="text-[11px] text-gray-400">{entry.lines.length} rader</p>
          </div>
        </div>
      </div>
    </motion.div>
  )
}

function JournalLinesDetail({ lines }: { lines: JournalEntryLine[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-[#EAEDF0]">
      <div className="grid grid-cols-[1fr_auto_auto] gap-0 border-b border-[#EAEDF0] bg-gray-50 px-4 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
          Konto
        </span>
        <span className="w-28 text-right text-[11px] font-semibold uppercase tracking-wide text-gray-400">
          Debet
        </span>
        <span className="w-28 text-right text-[11px] font-semibold uppercase tracking-wide text-gray-400">
          Kredit
        </span>
      </div>
      {lines.map((line) => (
        <div
          key={line.id}
          className="grid grid-cols-[1fr_auto_auto] gap-0 border-b border-[#EAEDF0] px-4 py-2.5 last:border-0"
        >
          <div className="flex items-center gap-3">
            <span className="w-12 font-mono text-[12px] font-bold text-gray-500">
              {line.account.number}
            </span>
            <span className="text-[13px] text-gray-700">{line.account.name}</span>
            {line.description && (
              <span className="text-[12px] text-gray-400">– {line.description}</span>
            )}
          </div>
          <span
            className={`w-28 text-right font-mono text-[13px] ${line.debit ? 'font-semibold text-gray-900' : 'text-gray-200'}`}
          >
            {line.debit ? formatCurrency(line.debit) : '–'}
          </span>
          <span
            className={`w-28 text-right font-mono text-[13px] ${line.credit ? 'font-semibold text-gray-900' : 'text-gray-200'}`}
          >
            {line.credit ? formatCurrency(line.credit) : '–'}
          </span>
        </div>
      ))}
    </div>
  )
}

export function AccountingPage() {
  const [view, setView] = useState<View>('chart')
  const [selectedEntry, setSelectedEntry] = useState<JournalEntry | null>(null)

  const accounts = useAccounts()
  const seedAccounts = useSeedAccounts()
  const journalEntries = useJournalEntries()

  const grouped = (accounts.data ?? []).reduce(
    (acc, a) => {
      const g = acc[a.type] ?? []
      g.push(a)
      acc[a.type] = g
      return acc
    },
    {} as Record<string, Account[]>,
  )

  const isLoading = view === 'chart' ? accounts.isLoading : journalEntries.isLoading
  const isError = view === 'chart' ? accounts.isError : journalEntries.isError

  return (
    <PageWrapper id="accounting">
      <PageHeader title="Bokföring" description="BAS-kontoplan och verifikationsjournal" />

      {/* Stats */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatCard title="Antal konton" value={accounts.data?.length ?? 0} icon={BookOpen} />
        <StatCard
          title="Antal verifikationer"
          value={journalEntries.data?.length ?? 0}
          icon={Database}
        />
      </div>

      {/* View toggle */}
      <div className="mt-6 flex w-fit items-center gap-1 rounded-xl bg-gray-100 p-1">
        {(
          [
            { id: 'chart', label: 'Kontoplan' },
            { id: 'journal', label: 'Verifikationer' },
          ] as const
        ).map((v) => (
          <button
            key={v.id}
            onClick={() => setView(v.id)}
            className={cn(
              'h-8 rounded-lg px-4 text-[13px] font-medium transition-all',
              view === v.id
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700',
            )}
          >
            {v.label}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="mt-5 space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-2xl bg-gray-100" />
          ))}
        </div>
      )}

      {isError && (
        <div className="mt-5">
          <EmptyState
            icon={FileX}
            title="Något gick fel"
            description="Kunde inte ladda bokföringsdata. Försök igen."
          />
        </div>
      )}

      {!isLoading && !isError && view === 'chart' && (
        <div className="mt-5 space-y-4">
          {Object.keys(grouped).length === 0 ? (
            <EmptyState
              icon={BookOpen}
              title="Inga konton"
              description="Lägg till standardkonton (BAS-kontoplan) för att komma igång."
              action={
                <Button
                  variant="primary"
                  onClick={() => seedAccounts.mutate()}
                  disabled={seedAccounts.isPending}
                >
                  {seedAccounts.isPending ? 'Lägger till…' : 'Lägg till standardkonton'}
                </Button>
              }
            />
          ) : (
            Object.entries(grouped).map(([type, accs], gi) => (
              <motion.div
                key={type}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: gi * 0.08 }}
                className="overflow-hidden rounded-2xl border border-[#EAEDF0] bg-white"
              >
                <div className="flex items-center justify-between border-b border-[#EAEDF0] px-4 py-3.5">
                  <div className="flex items-center gap-2">
                    <BookOpen size={14} className="text-gray-400" />
                    <h3 className="text-[13.5px] font-semibold text-gray-800">
                      {accountTypeLabel[type] ?? type}
                    </h3>
                  </div>
                  <span className="text-[12px] text-gray-400">{accs.length} konton</span>
                </div>
                <div className="px-2 py-1">
                  {accs.map((a, i) => (
                    <AccountRow key={a.id} account={a} delay={gi * 0.08 + i * 0.04} />
                  ))}
                </div>
              </motion.div>
            ))
          )}
        </div>
      )}

      {!isLoading && !isError && view === 'journal' && (
        <div className="mt-5 space-y-3">
          {(journalEntries.data ?? []).length === 0 ? (
            <EmptyState
              icon={FileX}
              title="Inga verifikationer"
              description="Verifikationer skapas automatiskt när fakturor registreras."
            />
          ) : (
            (journalEntries.data ?? []).map((je, i) => (
              <JournalEntryCard
                key={je.id}
                entry={je}
                delay={i * 0.06}
                onClick={() => setSelectedEntry(je)}
              />
            ))
          )}
        </div>
      )}

      {/* Detail modal */}
      <Modal
        open={selectedEntry !== null}
        onClose={() => setSelectedEntry(null)}
        title={selectedEntry?.description ?? ''}
        description={selectedEntry ? formatDate(selectedEntry.date) : ''}
      >
        {selectedEntry && <JournalLinesDetail lines={selectedEntry.lines} />}
      </Modal>
    </PageWrapper>
  )
}
