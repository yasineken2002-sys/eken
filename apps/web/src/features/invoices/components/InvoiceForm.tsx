import { useForm, useFieldArray, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Plus, Trash2, Building2 } from 'lucide-react'
import { Input, Select } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { ModalFooter } from '@/components/ui/Modal'
import { CreateInvoiceSchema, type CreateInvoiceInput } from '@eken/shared'
import { useTenants } from '@/features/tenants/hooks/useTenants'
import { cn } from '@/lib/cn'
import { useOrganization } from '@/features/settings/hooks/useSettings'

interface InvoiceFormProps {
  defaultValues?: Partial<CreateInvoiceInput>
  onSubmit: (data: CreateInvoiceInput) => void
  onCancel: () => void
  isSubmitting?: boolean
  submitLabel?: string
}

const INVOICE_TYPES = [
  { value: 'RENT', label: 'Hyra' },
  { value: 'DEPOSIT', label: 'Deposition' },
  { value: 'SERVICE', label: 'Tjänst' },
  { value: 'UTILITY', label: 'Drift' },
  { value: 'OTHER', label: 'Övrigt' },
]

const VAT_RATES = [
  { value: '0', label: '0%' },
  { value: '6', label: '6%' },
  { value: '12', label: '12%' },
  { value: '25', label: '25%' },
]

const TYPE_LABELS: Record<string, string> = {
  RENT: 'Hyra',
  DEPOSIT: 'Deposition',
  SERVICE: 'Tjänst',
  UTILITY: 'Drift',
  OTHER: 'Övrigt',
}

const today = new Date().toISOString().split('T')[0]!
const in30Days = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]!

function fmtSEK(amount: number): string {
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency: 'SEK',
    maximumFractionDigits: 0,
  }).format(amount)
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return '–'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '–'
  return d.toLocaleDateString('sv-SE')
}

export function InvoiceForm({
  defaultValues,
  onSubmit,
  onCancel,
  isSubmitting = false,
  submitLabel = 'Skapa faktura',
}: InvoiceFormProps) {
  const {
    register,
    control,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<CreateInvoiceInput>({
    resolver: zodResolver(CreateInvoiceSchema),
    defaultValues: {
      type: 'RENT',
      issueDate: today,
      dueDate: in30Days,
      lines: [{ description: '', quantity: 1, unitPrice: 0, vatRate: 25 }],
      ...defaultValues,
    },
  })

  const { fields, append, remove } = useFieldArray({ control, name: 'lines' })

  const watched = watch()
  const { data: tenants = [], isLoading: tenantsLoading } = useTenants()
  const { data: org } = useOrganization()

  const tenantOptions = tenants.map((t) => ({
    value: t.id,
    label:
      t.type === 'INDIVIDUAL'
        ? `${t.firstName ?? ''} ${t.lastName ?? ''}`.trim()
        : (t.companyName ?? '–'),
  }))

  // ── Preview calculations ───────────────────────────────────────────────────

  const selectedTenant = tenants.find((t) => t.id === watched.tenantId)
  const tenantName = selectedTenant
    ? selectedTenant.type === 'INDIVIDUAL'
      ? `${selectedTenant.firstName ?? ''} ${selectedTenant.lastName ?? ''}`.trim()
      : (selectedTenant.companyName ?? '–')
    : null

  const previewLines = (watched.lines ?? []).map((l) => {
    const qty = Number(l.quantity) || 0
    const price = Number(l.unitPrice) || 0
    const vat = Number(l.vatRate) || 0
    const net = qty * price
    const vatAmt = net * (vat / 100)
    return {
      description: l.description,
      qty,
      price,
      vatRate: vat,
      net,
      vatAmt,
      total: net + vatAmt,
    }
  })

  const subtotal = previewLines.reduce((s, l) => s + l.net, 0)
  const vatTotal = previewLines.reduce((s, l) => s + l.vatAmt, 0)
  const grandTotal = subtotal + vatTotal

  return (
    <div className="flex min-h-0 gap-0">
      {/* ── Left: Form ─────────────────────────────────────────────────────── */}
      <div className="w-[44%] shrink-0 overflow-y-auto pr-5" style={{ maxHeight: '78vh' }}>
        <form id="invoice-form" onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {/* Hyresgäst */}
            <div className="col-span-2">
              <Controller
                control={control}
                name="tenantId"
                render={({ field }) => (
                  <Select
                    label="Hyresgäst"
                    options={
                      tenantsLoading
                        ? [{ value: '', label: 'Laddar hyresgäster…' }]
                        : [{ value: '', label: 'Välj hyresgäst...' }, ...tenantOptions]
                    }
                    disabled={tenantsLoading}
                    error={errors.tenantId?.message}
                    {...field}
                  />
                )}
              />
            </div>

            {/* Typ */}
            <Select
              label="Fakturatyp"
              options={INVOICE_TYPES}
              error={errors.type?.message}
              {...register('type')}
            />

            {/* Referens */}
            <Input
              label="Referens / OCR"
              placeholder="t.ex. 9153"
              error={errors.reference?.message}
              {...register('reference')}
            />

            {/* Utfärdandedatum */}
            <Input
              label="Utfärdandedatum"
              type="date"
              error={errors.issueDate?.message}
              {...register('issueDate')}
            />

            {/* Förfallodatum */}
            <Input
              label="Förfallodatum"
              type="date"
              error={errors.dueDate?.message}
              {...register('dueDate')}
            />

            {/* Notering */}
            <div className="col-span-2">
              <Input
                label="Notering (valfri)"
                placeholder="Intern notering"
                error={errors.notes?.message}
                {...register('notes')}
              />
            </div>
          </div>

          {/* Fakturarader */}
          <div className="overflow-hidden rounded-xl border border-[#EAEDF0]">
            <div className="border-b border-[#EAEDF0] bg-gray-50 px-4 py-2.5">
              <p className="text-[12px] font-semibold text-gray-500">Fakturarader</p>
            </div>

            <div className="divide-y divide-[#EAEDF0]">
              {fields.map((field, idx) => (
                <div key={field.id} className="space-y-2 p-3">
                  <div className="flex items-start gap-2">
                    <div className="flex-1">
                      <Input
                        placeholder="Beskrivning"
                        error={errors.lines?.[idx]?.description?.message}
                        {...register(`lines.${idx}.description`)}
                      />
                    </div>
                    {fields.length > 1 && (
                      <button
                        type="button"
                        onClick={() => remove(idx)}
                        className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[#DDDFE4] text-gray-400 hover:border-red-200 hover:text-red-500 active:scale-[0.97]"
                      >
                        <Trash2 size={13} strokeWidth={1.8} />
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <Input
                      placeholder="Antal"
                      type="number"
                      step="0.01"
                      error={errors.lines?.[idx]?.quantity?.message}
                      {...register(`lines.${idx}.quantity`, { valueAsNumber: true })}
                    />
                    <Input
                      placeholder="À-pris (kr)"
                      type="number"
                      step="0.01"
                      error={errors.lines?.[idx]?.unitPrice?.message}
                      {...register(`lines.${idx}.unitPrice`, { valueAsNumber: true })}
                    />
                    <Controller
                      control={control}
                      name={`lines.${idx}.vatRate`}
                      render={({ field }) => (
                        <Select
                          options={VAT_RATES}
                          error={errors.lines?.[idx]?.vatRate?.message}
                          value={String(field.value)}
                          onChange={(e) => field.onChange(Number(e.target.value))}
                        />
                      )}
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between border-t border-[#EAEDF0] bg-gray-50 px-4 py-2.5">
              <button
                type="button"
                onClick={() => append({ description: '', quantity: 1, unitPrice: 0, vatRate: 25 })}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-medium text-blue-600',
                  'transition-all hover:bg-blue-50 active:scale-[0.97]',
                )}
              >
                <Plus size={13} strokeWidth={2} />
                Lägg till rad
              </button>
              <div className="text-right">
                <p className="text-[11px] font-medium text-gray-400">Totalt inkl. moms</p>
                <p className="text-[15px] font-semibold text-gray-900">{fmtSEK(grandTotal)}</p>
              </div>
            </div>
          </div>

          <ModalFooter>
            <Button type="button" onClick={onCancel} disabled={isSubmitting}>
              Avbryt
            </Button>
            <Button type="submit" variant="primary" disabled={isSubmitting}>
              {isSubmitting ? 'Sparar…' : submitLabel}
            </Button>
          </ModalFooter>
        </form>
      </div>

      {/* ── Divider ────────────────────────────────────────────────────────── */}
      <div className="mx-5 w-px shrink-0 bg-[#EAEDF0]" />

      {/* ── Right: Live preview ─────────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
          Förhandsgranskning
        </p>
        {/* Scale wrapper */}
        <div
          style={{
            width: '794px',
            transformOrigin: 'top left',
            transform: 'scale(0.72)',
            height: '0',
            overflow: 'visible',
          }}
        >
          <InvoicePreview
            orgName={org?.name ?? 'Din organisation'}
            tenantName={tenantName}
            invoiceType={TYPE_LABELS[watched.type ?? 'RENT'] ?? ''}
            reference={watched.reference ?? ''}
            issueDate={watched.issueDate}
            dueDate={watched.dueDate}
            lines={previewLines}
            subtotal={subtotal}
            vatTotal={vatTotal}
            grandTotal={grandTotal}
            bankgiro={org?.bankgiro}
            invoiceColor={org?.invoiceColor ?? '#1a6b3c'}
            invoiceTemplate={org?.invoiceTemplate ?? 'classic'}
          />
        </div>
      </div>
    </div>
  )
}

// ─── Invoice Preview ──────────────────────────────────────────────────────────

interface PreviewLine {
  description: string
  qty: number
  price: number
  vatRate: number
  net: number
  vatAmt: number
  total: number
}

interface InvoicePreviewProps {
  orgName: string
  tenantName: string | null
  invoiceType: string
  reference: string
  issueDate: string | undefined
  dueDate: string | undefined
  lines: PreviewLine[]
  subtotal: number
  vatTotal: number
  grandTotal: number
  bankgiro: string | undefined
  invoiceColor?: string
  invoiceTemplate?: string
}

function InvoicePreview({
  orgName,
  tenantName,
  invoiceType,
  reference,
  issueDate,
  dueDate,
  lines,
  subtotal,
  vatTotal,
  grandTotal,
  bankgiro,
  invoiceColor = '#1a6b3c',
  invoiceTemplate = 'classic',
}: InvoicePreviewProps) {
  // Build template-specific header
  let headerNode: React.ReactNode

  if (invoiceTemplate === 'modern') {
    headerNode = (
      <div
        style={{
          background: invoiceColor,
          padding: '20px 44px',
          margin: '-40px -44px 32px -44px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ fontSize: '18px', fontWeight: 700, color: '#ffffff' }}>{orgName}</span>
        <span
          style={{ fontSize: '26px', fontWeight: 800, color: '#ffffff', letterSpacing: '-0.5px' }}
        >
          FAKTURA
        </span>
      </div>
    )
  } else if (invoiceTemplate === 'minimal') {
    headerNode = (
      <div
        style={{
          marginBottom: '24px',
          paddingBottom: '12px',
          borderBottom: `2px solid ${invoiceColor}`,
        }}
      >
        <div
          style={{
            fontSize: '22px',
            fontWeight: 700,
            color: invoiceColor,
            letterSpacing: '-0.3px',
          }}
        >
          {orgName}
        </div>
      </div>
    )
  } else {
    // classic
    headerNode = (
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: '32px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div
            style={{
              width: '36px',
              height: '36px',
              borderRadius: '8px',
              background: `${invoiceColor}18`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Building2 size={18} strokeWidth={1.8} style={{ color: invoiceColor }} />
          </div>
          <span
            style={{
              fontSize: '18px',
              fontWeight: 700,
              color: invoiceColor,
              letterSpacing: '-0.3px',
            }}
          >
            {orgName}
          </span>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div
            style={{
              fontSize: '26px',
              fontWeight: 700,
              color: invoiceColor,
              letterSpacing: '-0.5px',
            }}
          >
            FAKTURA
          </div>
          {reference && (
            <div
              style={{
                display: 'inline-block',
                marginTop: '6px',
                background: `${invoiceColor}18`,
                color: invoiceColor,
                borderRadius: '20px',
                padding: '3px 12px',
                fontSize: '12px',
                fontWeight: 600,
              }}
            >
              OCR: {reference}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      style={{
        width: '794px',
        minHeight: '600px',
        background: '#fff',
        border: '1px solid #e8eaed',
        borderRadius: '8px',
        padding: '40px 44px',
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: '13px',
        color: '#1a1a1a',
      }}
    >
      {headerNode}

      {/* Meta grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '12px',
          marginBottom: '28px',
          background: '#f8fafb',
          borderRadius: '8px',
          padding: '16px',
        }}
      >
        <MetaCell
          label="Hyresgäst"
          value={tenantName ?? <em style={{ color: '#9CA3AF' }}>Välj hyresgäst</em>}
        />
        <MetaCell label="Fakturatyp" value={invoiceType || '–'} />
        <MetaCell label="Utfärdandedatum" value={fmtDate(issueDate)} />
        <MetaCell label="Förfallodatum" value={fmtDate(dueDate)} />
      </div>

      {/* Lines table */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '4px' }}>
        <thead>
          <tr style={{ background: '#f8fafb', borderBottom: '2px solid #e8eaed' }}>
            {['Beskrivning', 'Antal', 'À-pris', 'Moms', 'Belopp'].map((h) => (
              <th
                key={h}
                style={{
                  padding: '8px 10px',
                  textAlign: h === 'Beskrivning' ? 'left' : 'right',
                  fontSize: '11px',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  color: '#6B7280',
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 ? (
            <tr>
              <td
                colSpan={5}
                style={{
                  padding: '16px 10px',
                  color: '#9CA3AF',
                  fontSize: '12px',
                  textAlign: 'center',
                }}
              >
                Inga fakturarader
              </td>
            </tr>
          ) : (
            lines.map((l, i) => (
              <tr key={i} style={{ borderBottom: '1px solid #f0f2f4' }}>
                <td
                  style={{
                    padding: '9px 10px',
                    color: l.description ? '#1a1a1a' : '#9CA3AF',
                    fontStyle: l.description ? 'normal' : 'italic',
                  }}
                >
                  {l.description || 'Beskrivning…'}
                </td>
                <td style={{ padding: '9px 10px', textAlign: 'right', color: '#374151' }}>
                  {l.qty}
                </td>
                <td style={{ padding: '9px 10px', textAlign: 'right', color: '#374151' }}>
                  {fmtSEK(l.price)}
                </td>
                <td style={{ padding: '9px 10px', textAlign: 'right', color: '#6B7280' }}>
                  {l.vatRate}%
                </td>
                <td
                  style={{
                    padding: '9px 10px',
                    textAlign: 'right',
                    fontWeight: 600,
                    color: '#111827',
                  }}
                >
                  {fmtSEK(l.total)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {/* Totals */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '8px' }}>
        <div style={{ width: '260px' }}>
          <TotalRow label="Netto exkl. moms" value={fmtSEK(subtotal)} />
          <TotalRow label="Moms" value={fmtSEK(vatTotal)} />
          <div style={{ borderTop: `2px solid ${invoiceColor}`, margin: '8px 0' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontSize: '13px', fontWeight: 700, color: invoiceColor }}>
              Att betala
            </span>
            <span
              style={{
                fontSize: '20px',
                fontWeight: 800,
                color: invoiceColor,
                letterSpacing: '-0.3px',
              }}
            >
              {fmtSEK(grandTotal)}
            </span>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div
        style={{
          marginTop: '32px',
          paddingTop: '14px',
          borderTop: '1px solid #e8eaed',
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: '11px',
          color: '#9CA3AF',
        }}
      >
        <span>Bankgiro: {bankgiro ?? '–'}</span>
        <span>{orgName}</span>
      </div>
    </div>
  )
}

function MetaCell({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: '10px',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: '#9CA3AF',
          marginBottom: '3px',
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: '13px', fontWeight: 500, color: '#111827' }}>{value}</div>
    </div>
  )
}

function TotalRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: '3px 0',
        fontSize: '12px',
        color: '#6B7280',
      }}
    >
      <span>{label}</span>
      <span>{value}</span>
    </div>
  )
}
