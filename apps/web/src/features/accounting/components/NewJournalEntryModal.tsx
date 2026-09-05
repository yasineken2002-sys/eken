import { useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Badge } from '@/components/ui/Badge'
import { useCreateJournalEntry } from '../hooks/useAccounting'
import { beraknaSaldo, tolkaBelopp, verifikatFel, type RadUtkast } from './entry-balance'
import { extractApiError } from '@/lib/api'
import { kontraktsfel } from './contract-gate'
import type { CreateJournalEntryInput } from '@eken/shared'
import { CreateJournalEntrySchema, formatCurrency } from '@eken/shared'
import type { Account } from '@eken/shared'

/**
 * NY VERIFIKATION — människans väg till det AI-verktyget `create_journal_entry`
 * gör. Verktyget stod i `tool-human-path.baseline.json` som ett av sju utan
 * mänsklig väg; den här modalen plus POST /accounting/journal-entries är vägen.
 *
 * ── SALDOT RÄKNAS UTANFÖR KOMPONENTEN ───────────────────────────────────────
 *
 * `beraknaSaldo` och `verifikatFel` är rena funktioner i `entry-balance.ts`.
 * Webs vitest renderar ingenting (`environment: 'node'`), så räkningen måste bo
 * där för att gå att pröva. Knappens villkor och felmeddelandet kommer från
 * SAMMA funktion, så de kan inte säga olika saker.
 *
 * ── DET LÖPANDE SALDOT ÄR ETT BESKED, INTE EN SPÄRR ─────────────────────────
 *
 * Balanskravet verkställs i `createNumberedEntry` (C1). Skulle knappen släppa
 * igenom en obalans svarar servern 422 med samma belopp i meddelandet.
 *
 * ── IDEMPOTENSNYCKELN SÄTTS NÄR MODALEN ÖPPNAS ──────────────────────────────
 *
 * En nyckel per öppnad modal, inte per klick: två klick på "Bokför" (dubbelklick,
 * eller ett omtag efter en tappad uppkoppling) ska ge EN journalpost. Nyckeln
 * nollställs när modalen stängs, så nästa verifikat är ett nytt.
 */

const TOM_RAD: RadUtkast = { accountNumber: '', debit: '', credit: '', description: '' }

interface Props {
  open: boolean
  onClose: () => void
  accounts: readonly Account[]
}

export function NewJournalEntryModal({ open, onClose, accounts }: Props) {
  const idag = new Date().toISOString().slice(0, 10)
  const [datum, setDatum] = useState(idag)
  const [beskrivning, setBeskrivning] = useState('')
  const [rader, setRader] = useState<RadUtkast[]>([{ ...TOM_RAD }, { ...TOM_RAD }])
  const [bilaga, setBilaga] = useState('')
  const [nyckel, setNyckel] = useState(() => crypto.randomUUID())
  const [serverfel, setServerfel] = useState<string | null>(null)

  const mutation = useCreateJournalEntry()

  const kontonamn = useMemo(() => {
    const karta = new Map<number, string>()
    for (const konto of accounts) karta.set(konto.number, konto.name)
    return karta
  }, [accounts])

  const saldo = beraknaSaldo(rader)
  const fel = verifikatFel(rader, beskrivning, datum)

  const stang = () => {
    setDatum(idag)
    setBeskrivning('')
    setRader([{ ...TOM_RAD }, { ...TOM_RAD }])
    setBilaga('')
    setServerfel(null)
    setNyckel(crypto.randomUUID())
    onClose()
  }

  const andraRad = (i: number, fält: keyof RadUtkast, värde: string) => {
    setRader((f) => f.map((r, j) => (j === i ? { ...r, [fält]: värde } : r)))
  }

  const bokfor = () => {
    if (fel) return
    setServerfel(null)
    // ANNOTERAD med flit. Utan typen är `kropp` en inferrerad const, och då
    // körs INGEN överskottskontroll: ett fält som finns här men inte i
    // kontraktet passerar tyst. Uppmätt i negativkontrollen — API-sidan blev
    // röd, webben inte, förrän den här raden fanns.
    const kropp: CreateJournalEntryInput = {
      date: datum,
      description: beskrivning.trim(),
      idempotencyKey: nyckel,
      ...(bilaga.trim() ? { attachmentUrl: bilaga.trim() } : {}),
      lines: rader
        .filter((r) => r.accountNumber.trim() !== '')
        .map((r) => {
          const debit = tolkaBelopp(r.debit)
          const credit = tolkaBelopp(r.credit)
          return {
            accountNumber: Number(r.accountNumber),
            ...(debit > 0 ? { debit } : {}),
            ...(credit > 0 ? { credit } : {}),
            ...(r.description?.trim() ? { description: r.description.trim() } : {}),
          }
        }),
    }

    // SISTA GRINDEN: nyttolasten prövas mot det DELADE schemat innan den lämnar
    // webbläsaren. Formulärets egna regler har redan talat ovan; den här fångar
    // det de missar — och det är samma form som i #795 blev ett 400-svar.
    const kontrakt = kontraktsfel(CreateJournalEntrySchema, kropp)
    if (kontrakt) {
      setServerfel(kontrakt)
      return
    }

    mutation.mutate(kropp, {
      onSuccess: stang,
      onError: (err) => setServerfel(extractApiError(err, 'Kunde inte bokföra verifikatet')),
    })
  }

  return (
    <Modal
      open={open}
      onClose={stang}
      title="Ny verifikation"
      description="Bokför ett fritt verifikat. Debet och kredit måste vara lika."
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Datum"
            type="date"
            value={datum}
            onChange={(e) => setDatum(e.target.value)}
            data-testid="journal-date"
          />
          <Input
            label="Beskrivning"
            value={beskrivning}
            onChange={(e) => setBeskrivning(e.target.value)}
            placeholder="Vad avser verifikatet?"
            data-testid="journal-description"
          />
        </div>

        <div>
          <p className="mb-2 text-[13px] font-medium text-gray-700">Konteringsrader</p>
          <div className="border-line overflow-hidden rounded-2xl border">
            <table className="w-full text-[13.5px]">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/60">
                  <th className="px-3 py-2 text-left text-[11.5px] font-semibold uppercase tracking-wider text-gray-400">
                    Konto
                  </th>
                  <th className="px-3 py-2 text-right text-[11.5px] font-semibold uppercase tracking-wider text-gray-400">
                    Debet
                  </th>
                  <th className="px-3 py-2 text-right text-[11.5px] font-semibold uppercase tracking-wider text-gray-400">
                    Kredit
                  </th>
                  <th className="w-10 px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rader.map((rad, i) => {
                  const namn = kontonamn.get(Number(rad.accountNumber))
                  return (
                    <tr
                      key={i}
                      className="border-b border-[var(--ev-row-border)] last:border-0"
                      data-testid={`journal-row-${i}`}
                    >
                      <td className="px-3 py-2">
                        <input
                          className="border-input h-9 w-full rounded-lg border bg-white px-2.5 text-[13.5px] text-gray-900"
                          value={rad.accountNumber}
                          onChange={(e) => andraRad(i, 'accountNumber', e.target.value)}
                          placeholder="1930"
                          inputMode="numeric"
                          aria-label={`Konto rad ${i + 1}`}
                        />
                        {namn && <p className="mt-1 text-[12px] text-gray-400">{namn}</p>}
                      </td>
                      <td className="px-3 py-2">
                        <input
                          className="border-input h-9 w-full rounded-lg border bg-white px-2.5 text-right text-[13.5px] text-gray-900"
                          value={rad.debit}
                          onChange={(e) => andraRad(i, 'debit', e.target.value)}
                          inputMode="decimal"
                          aria-label={`Debet rad ${i + 1}`}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          className="border-input h-9 w-full rounded-lg border bg-white px-2.5 text-right text-[13.5px] text-gray-900"
                          value={rad.credit}
                          onChange={(e) => andraRad(i, 'credit', e.target.value)}
                          inputMode="decimal"
                          aria-label={`Kredit rad ${i + 1}`}
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        {rader.length > 2 && (
                          <button
                            type="button"
                            onClick={() => setRader((f) => f.filter((_, j) => j !== i))}
                            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                            aria-label={`Ta bort rad ${i + 1}`}
                          >
                            <Trash2 size={14} strokeWidth={1.8} />
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-2 flex items-center justify-between">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRader((f) => [...f, { ...TOM_RAD }])}
            >
              <Plus size={14} strokeWidth={1.8} />
              Lägg till rad
            </Button>

            {/* Det löpande saldot. Neutralt tills något är ifyllt — en röd
                "obalans" på ett tomt formulär är ett larm om ingenting. */}
            <div className="flex items-center gap-3 text-[13px]" data-testid="journal-balance">
              <span className="text-gray-500">
                Debet {formatCurrency(saldo.debet)} · Kredit {formatCurrency(saldo.kredit)}
              </span>
              {saldo.radermedBelopp === 0 ? (
                <Badge variant="default">Inget belopp</Badge>
              ) : saldo.balanserar ? (
                <Badge variant="success" dot>
                  Balanserar
                </Badge>
              ) : (
                <Badge variant="warning" dot>
                  Differens {formatCurrency(Math.abs(saldo.differens))}
                </Badge>
              )}
            </div>
          </div>
        </div>

        <Input
          label="Bilaga (valfri)"
          value={bilaga}
          onChange={(e) => setBilaga(e.target.value)}
          placeholder="Länk till kvitto eller underlag"
          hint="Underlaget ska gå att hitta i sju år (BFL 7 kap)."
        />

        {(serverfel ?? fel) && (
          <p
            className={
              serverfel
                ? 'rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] text-red-600'
                : 'text-[12px] text-gray-400'
            }
            data-testid="journal-error"
          >
            {serverfel ?? fel}
          </p>
        )}
      </div>

      <ModalFooter>
        <Button variant="secondary" onClick={stang}>
          Avbryt
        </Button>
        <Button
          variant="primary"
          onClick={bokfor}
          disabled={fel !== null || mutation.isPending}
          data-testid="journal-submit"
        >
          {mutation.isPending ? 'Bokför…' : 'Bokför'}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
