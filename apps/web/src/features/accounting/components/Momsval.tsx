import { formatCurrency } from '@eken/shared'
import type { SupplierVatTreatment } from '@eken/shared'

/**
 * TESTKUND-041 (moms v1, B-1; kundtext TILLAGG-KONTRAKT-033 §0): kundens UTTRYCKLIGA momsval.
 * Inget förval och ingen härledning ur momssatsen — valet görs här av en människa. Texten beskriver
 * bara beslutet och beloppseffekten; inga interna regler eller produktval visas i valet.
 */
export function momsvalText(val: SupplierVatTreatment, moms: number, brutto: number): string {
  if (val === 'INGEN_MOMS') return 'Ingen moms på fakturan'
  if (val === 'HELT_AVDRAG') return `Moms ${formatCurrency(moms)} dras av (bokas som ingående moms)`
  return `Moms ${formatCurrency(moms)} dras inte av (ingår i kostnaden ${formatCurrency(brutto)})`
}

export function Momsval({
  moms,
  brutto,
  value,
  onChange,
  testid,
}: {
  moms: number
  brutto: number
  value: SupplierVatTreatment | ''
  onChange: (v: SupplierVatTreatment) => void
  testid: string
}) {
  const val: SupplierVatTreatment[] = moms > 0 ? ['HELT_AVDRAG', 'INGET_AVDRAG'] : ['INGEN_MOMS']
  return (
    <fieldset className="min-w-0 space-y-1.5" data-testid={testid}>
      <legend className="mb-1.5 text-[13px] font-medium text-gray-700">Moms</legend>
      {val.map((v) => (
        <label key={v} className="flex min-w-0 items-start gap-2 text-[13px] text-gray-800">
          <input
            type="radio"
            name={testid}
            className="mt-0.5 shrink-0"
            checked={value === v}
            onChange={() => onChange(v)}
            data-momsval={v}
          />
          <span className="min-w-0 break-words">{momsvalText(v, moms, brutto)}</span>
        </label>
      ))}
    </fieldset>
  )
}
