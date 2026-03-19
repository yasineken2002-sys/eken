import { useState } from 'react'
import { motion } from 'framer-motion'
import { Plus, BookOpen } from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { mockAccounts, mockJournalEntries } from '@/lib/mock-data'
import { formatCurrency, formatDate } from '@eken/shared'
import type { Account } from '@eken/shared'
import { cn } from '@/lib/cn'

type View = 'chart' | 'journal'

const accountTypeLabel: Record<string, string> = {
  ASSET: 'Tillgång',
  LIABILITY: 'Skuld',
  EQUITY: 'Eget kapital',
  REVENUE: 'Intäkt',
  EXPENSE: 'Kostnad',
}
const accountTypeVariant: Record<string, 'success' | 'danger' | 'info' | 'warning' | 'default'> = {
  ASSET: 'success',
  LIABILITY: 'danger',
  EQUITY: 'info',
  REVENUE: 'info',
  EXPENSE: 'warning',
}

function AccountRow({ account, delay }: { account: Account; delay: number }) {
  const numStr = account.number.toString()
  const color =
    parseInt(numStr[0] ?? '5') === 1
      ? 'bg-emerald-50 text-emerald-700'
      : parseInt(numStr[0] ?? '5') === 2
        ? 'bg-red-50 text-red-700'
        : parseInt(numStr[0] ?? '5') === 3
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

export function AccountingPage() {
  const [view, setView] = useState<View>('chart')
  const [showCreate, setShowCreate] = useState(false)

  const grouped = mockAccounts.reduce(
    (acc, a) => {
      const g = acc[a.type] ?? []
      g.push(a)
      acc[a.type] = g
      return acc
    },
    {} as Record<string, Account[]>,
  )

  return (
    <PageWrapper id="accounting">
      <PageHeader
        title="Bokföring"
        description="BAS-kontoplan och verifikationsjournal"
        action={
          <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
            <Plus size={14} />
            Nytt verifikat
          </Button>
        }
      />

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
            onClick={() => setView(v.id as View)}
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

      {view === 'chart' && (
        <div className="mt-5 space-y-4">
          {Object.entries(grouped).map(([type, accounts], gi) => (
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
                    {accountTypeLabel[type] ?? type}er
                  </h3>
                </div>
                <span className="text-[12px] text-gray-400">{accounts.length} konton</span>
              </div>
              <div className="px-2 py-1">
                {accounts.map((a, i) => (
                  <AccountRow key={a.id} account={a} delay={gi * 0.08 + i * 0.04} />
                ))}
              </div>
            </motion.div>
          ))}
        </div>
      )}

      {view === 'journal' && (
        <div className="mt-5 space-y-3">
          {mockJournalEntries.map((je, i) => (
            <motion.div
              key={je.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.08 }}
              className="overflow-hidden rounded-2xl border border-[#EAEDF0] bg-white"
            >
              <div className="flex items-center justify-between border-b border-[#EAEDF0] px-5 py-3.5">
                <div>
                  <p className="text-[14px] font-semibold text-gray-900">{je.description}</p>
                  <p className="mt-0.5 text-[12px] text-gray-400">
                    {formatDate(je.date)}
                    {je.reference ? ` · ${je.reference}` : ''}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-[13px] font-semibold text-gray-700">
                    {formatCurrency(je.lines.reduce((s, l) => s + (l.debit ?? 0), 0))}
                  </p>
                  <p className="text-[11px] text-gray-400">Totalt debet</p>
                </div>
              </div>
              <div className="px-5 py-2">
                {je.lines.map((line) => (
                  <div
                    key={line.id}
                    className="flex items-center justify-between border-b border-[#EAEDF0] py-2 last:border-0"
                  >
                    <div className="flex items-center gap-3">
                      <span className="w-12 font-mono text-[12px] font-bold text-gray-500">
                        {line.accountNumber}
                      </span>
                      <span className="text-[13px] text-gray-700">{line.accountName}</span>
                      {line.description && (
                        <span className="text-[12px] text-gray-400">– {line.description}</span>
                      )}
                    </div>
                    <div className="flex gap-6 text-[13px]">
                      <span
                        className={`w-24 text-right font-mono ${line.debit ? 'font-semibold text-gray-900' : 'text-gray-200'}`}
                      >
                        {line.debit ? formatCurrency(line.debit) : '–'}
                      </span>
                      <span
                        className={`w-24 text-right font-mono ${line.credit ? 'font-semibold text-gray-900' : 'text-gray-200'}`}
                      >
                        {line.credit ? formatCurrency(line.credit) : '–'}
                      </span>
                    </div>
                  </div>
                ))}
                <div className="flex justify-end gap-6 pb-1 pt-2">
                  <p className="w-24 text-right text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                    Debet
                  </p>
                  <p className="w-24 text-right text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                    Kredit
                  </p>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      )}

      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Nytt verifikat"
        description="Manuell bokföringspost"
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Input label="Beskrivning" placeholder="t.ex. Hyresinbetalning nov" />
            </div>
            <Input label="Datum" type="date" />
            <Input label="Referens" placeholder="Fakturanr / OCR" />
          </div>
          <div className="overflow-hidden rounded-xl border border-[#EAEDF0]">
            <div className="grid grid-cols-4 gap-0 border-b border-[#EAEDF0] bg-gray-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              <span className="col-span-2">Konto</span>
              <span className="text-right">Debet</span>
              <span className="text-right">Kredit</span>
            </div>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="grid grid-cols-4 gap-2 border-b border-[#EAEDF0] px-3 py-2 last:border-0"
              >
                <Input placeholder="1930" className="col-span-2" />
                <Input placeholder="0,00" type="number" />
                <Input placeholder="0,00" type="number" />
              </div>
            ))}
          </div>
          <ModalFooter>
            <Button onClick={() => setShowCreate(false)}>Avbryt</Button>
            <Button variant="primary" onClick={() => setShowCreate(false)}>
              Bokför
            </Button>
          </ModalFooter>
        </div>
      </Modal>
    </PageWrapper>
  )
}
