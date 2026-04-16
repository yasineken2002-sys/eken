import { useState, useEffect, useRef } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Upload, Building2, AlertCircle, Check, Brain, Info } from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { EmptyState } from '@/components/ui/EmptyState'
import { useOrganization, useUpdateOrganization, useUploadLogo } from './hooks/useSettings'
import { clearAiMemory } from '@/features/ai/api/ai.api'
import { cn } from '@/lib/cn'

// ─── Form schema ──────────────────────────────────────────────────────────────

const PaymentFormSchema = z.object({
  bankgiro: z.string().optional(),
  paymentTermsDays: z.coerce.number().min(1).optional(),
})

type PaymentFormValues = z.infer<typeof PaymentFormSchema>

// ─── Page ─────────────────────────────────────────────────────────────────────

export function SettingsPage() {
  const { data: org, isLoading, isError } = useOrganization()
  const updateMutation = useUpdateOrganization()
  const uploadMutation = useUploadLogo()

  const [savedFlash, setSavedFlash] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [invoiceColor, setInvoiceColor] = useState('#1a6b3c')
  const [invoiceTemplate, setInvoiceTemplate] = useState('classic')
  const [invoiceSavedFlash, setInvoiceSavedFlash] = useState(false)

  const [morningReportEnabled, setMorningReportEnabled] = useState(false)
  const [aiMemoriesEnabled, setAiMemoriesEnabled] = useState(() => {
    return localStorage.getItem('eken-ai-memories-enabled') !== 'false'
  })
  const [clearMemoriesConfirm, setClearMemoriesConfirm] = useState(false)
  const [clearMemoriesFlash, setClearMemoriesFlash] = useState(false)
  const [clearMemoriesLoading, setClearMemoriesLoading] = useState(false)

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<PaymentFormValues>({
    resolver: zodResolver(PaymentFormSchema),
    defaultValues: { bankgiro: '', paymentTermsDays: 30 },
  })

  // Populate form once org loads
  useEffect(() => {
    if (org) {
      reset({
        bankgiro: org.bankgiro ?? '',
        paymentTermsDays: org.paymentTermsDays ?? 30,
      })
      setInvoiceColor(org.invoiceColor ?? '#1a6b3c')
      setInvoiceTemplate(org.invoiceTemplate ?? 'classic')
      setMorningReportEnabled(org.morningReportEnabled ?? false)
    }
  }, [org, reset])

  const handleSave = (v: PaymentFormValues) => {
    updateMutation.mutate(
      {
        ...(v.bankgiro ? { bankgiro: v.bankgiro } : {}),
        ...(v.paymentTermsDays != null ? { paymentTermsDays: v.paymentTermsDays } : {}),
      },
      {
        onSuccess: () => {
          setSavedFlash(true)
          setTimeout(() => setSavedFlash(false), 2500)
        },
      },
    )
  }

  const handleMorningReportToggle = (value: boolean) => {
    setMorningReportEnabled(value)
    updateMutation.mutate({ morningReportEnabled: value })
  }

  const handleAiMemoriesToggle = (value: boolean) => {
    setAiMemoriesEnabled(value)
    localStorage.setItem('eken-ai-memories-enabled', String(value))
  }

  const handleClearMemories = async () => {
    setClearMemoriesLoading(true)
    try {
      await clearAiMemory()
      setClearMemoriesFlash(true)
      setClearMemoriesConfirm(false)
      setTimeout(() => setClearMemoriesFlash(false), 2500)
    } catch {
      // silently fail
    } finally {
      setClearMemoriesLoading(false)
    }
  }

  const handleSaveInvoiceSettings = () => {
    updateMutation.mutate(
      { invoiceColor, invoiceTemplate },
      {
        onSuccess: () => {
          setInvoiceSavedFlash(true)
          setTimeout(() => setInvoiceSavedFlash(false), 2500)
        },
      },
    )
  }

  const handleFileSelect = (file: File) => {
    setUploadError(null)

    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setUploadError('Endast PNG, JPEG och WebP tillåts')
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      setUploadError('Filen är för stor. Max 2 MB.')
      return
    }

    uploadMutation.mutate(file)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) handleFileSelect(file)
  }

  if (isError) {
    return (
      <PageWrapper id="settings">
        <EmptyState
          icon={Building2}
          title="Något gick fel"
          description="Kunde inte ladda inställningar. Försök igen."
        />
      </PageWrapper>
    )
  }

  const logoUrl = org?.logoUrl ? `/uploads/${org.logoUrl.replace(/^uploads\//, '')}` : null

  return (
    <PageWrapper id="settings">
      <PageHeader title="Inställningar" description="Hantera din organisations uppgifter" />

      {isLoading ? (
        <div className="mt-6 space-y-5">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-48 animate-pulse rounded-2xl bg-gray-100" />
          ))}
        </div>
      ) : (
        <div className="mt-6 space-y-5">
          {/* ── Section 1: Logotyp ──────────────────────────────────────────── */}
          <section className="rounded-2xl border border-[#EAEDF0] bg-white p-5">
            <h2 className="mb-4 text-[14px] font-semibold text-gray-800">Företagslogotyp</h2>

            <div className="flex items-start gap-6">
              {/* Current logo */}
              {logoUrl && (
                <div className="flex-shrink-0">
                  <img
                    src={logoUrl}
                    alt="Logotyp"
                    className="h-20 w-20 rounded-xl border border-[#EAEDF0] object-contain p-2"
                  />
                </div>
              )}

              {/* Upload zone */}
              <div className="flex-1">
                <div
                  className={cn(
                    'flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 transition-colors',
                    uploadMutation.isPending
                      ? 'border-blue-200 bg-blue-50'
                      : 'border-[#DDDFE4] hover:border-blue-300 hover:bg-blue-50/40',
                  )}
                  onClick={() => fileInputRef.current?.click()}
                  onDrop={handleDrop}
                  onDragOver={(e) => e.preventDefault()}
                >
                  {uploadMutation.isPending ? (
                    <div className="flex items-center gap-2 text-[13px] text-blue-600">
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
                      Laddar upp…
                    </div>
                  ) : (
                    <>
                      <Upload size={20} strokeWidth={1.5} className="mb-2 text-gray-400" />
                      <p className="text-[13px] font-medium text-gray-700">
                        {logoUrl ? 'Byt logotyp' : 'Ladda upp logotyp'}
                      </p>
                      <p className="mt-1 text-[12px] text-gray-400">
                        PNG, JPEG eller WebP · max 2 MB
                      </p>
                    </>
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) handleFileSelect(file)
                  }}
                />
                {uploadError && (
                  <div className="mt-2 flex items-center gap-1.5 text-[12px] text-red-600">
                    <AlertCircle size={13} />
                    {uploadError}
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* ── Section 2: Betalningsinformation ────────────────────────────── */}
          <section className="rounded-2xl border border-[#EAEDF0] bg-white p-5">
            <h2 className="mb-4 text-[14px] font-semibold text-gray-800">Betalningsinformation</h2>

            <form onSubmit={handleSubmit(handleSave)} className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Input
                  label="Bankgiro"
                  placeholder="1234-5678"
                  error={errors.bankgiro?.message}
                  {...register('bankgiro')}
                />
                <Input
                  label="Betalningsvillkor (dagar)"
                  type="number"
                  placeholder="30"
                  error={errors.paymentTermsDays?.message}
                  {...register('paymentTermsDays')}
                />
              </div>

              <div className="flex items-center gap-3">
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  loading={updateMutation.isPending}
                >
                  Spara
                </Button>
                {savedFlash && (
                  <span className="text-[13px] font-medium text-emerald-600">Sparat!</span>
                )}
              </div>
            </form>
          </section>

          {/* ── Section 3: Fakturainställningar ─────────────────────────────── */}
          <section className="rounded-2xl border border-[#EAEDF0] bg-white p-5">
            <h2 className="mb-5 text-[14px] font-semibold text-gray-800">Fakturainställningar</h2>

            {/* FÄRGVAL */}
            <div className="mb-6">
              <p className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Fakturafärg
              </p>
              <div className="flex flex-wrap items-center gap-3">
                {[
                  { hex: '#1a6b3c', label: 'Grön' },
                  { hex: '#1a3a6b', label: 'Blå' },
                  { hex: '#6b1a1a', label: 'Röd' },
                  { hex: '#4a1a6b', label: 'Lila' },
                  { hex: '#1a5a6b', label: 'Petrol' },
                  { hex: '#2c2c2c', label: 'Svart' },
                ].map(({ hex }) => (
                  <button
                    key={hex}
                    type="button"
                    onClick={() => setInvoiceColor(hex)}
                    title={hex}
                    className={cn(
                      'relative flex h-8 w-8 items-center justify-center rounded-full transition-all active:scale-[0.97]',
                      invoiceColor === hex ? 'ring-2 ring-offset-2' : '',
                    )}
                    style={{
                      backgroundColor: hex,
                      ...(invoiceColor === hex ? { ringColor: hex } : {}),
                    }}
                  >
                    {invoiceColor === hex && <Check size={14} strokeWidth={2.5} color="#ffffff" />}
                  </button>
                ))}
                <div className="ml-2 flex items-center gap-2">
                  <input
                    type="color"
                    value={invoiceColor}
                    onChange={(e) => setInvoiceColor(e.target.value)}
                    className="h-8 w-8 cursor-pointer rounded-full border border-[#DDDFE4] p-0.5"
                    title="Anpassad färg"
                  />
                  <span className="text-[12px] text-gray-400">Anpassad</span>
                </div>
              </div>
            </div>

            {/* FAKTURAMALLAR */}
            <div className="mb-5">
              <p className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                Fakturamall
              </p>
              <div className="grid grid-cols-3 gap-3">
                {(
                  [
                    { value: 'classic', label: 'Klassisk' },
                    { value: 'modern', label: 'Modern' },
                    { value: 'minimal', label: 'Minimal' },
                  ] as const
                ).map((tpl) => (
                  <button
                    key={tpl.value}
                    type="button"
                    onClick={() => setInvoiceTemplate(tpl.value)}
                    className={cn(
                      'rounded-xl border p-3 text-left transition-all active:scale-[0.97]',
                      invoiceTemplate === tpl.value
                        ? 'border-2 shadow-sm'
                        : 'border-[#EAEDF0] hover:border-gray-300',
                    )}
                    style={
                      invoiceTemplate === tpl.value
                        ? { borderColor: invoiceColor, backgroundColor: `${invoiceColor}08` }
                        : {}
                    }
                  >
                    {/* SVG thumbnail */}
                    <svg
                      width="100"
                      height="70"
                      viewBox="0 0 100 70"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                      className="mb-2 w-full"
                    >
                      {tpl.value === 'classic' && (
                        <>
                          <rect width="100" height="70" rx="4" fill="#f9fafb" />
                          <rect
                            x="6"
                            y="8"
                            width="28"
                            height="8"
                            rx="2"
                            fill={invoiceColor}
                            opacity="0.8"
                          />
                          <rect x="66" y="8" width="28" height="8" rx="2" fill={invoiceColor} />
                          <rect x="6" y="24" width="88" height="1" fill="#e5e7eb" />
                          <rect x="6" y="30" width="60" height="4" rx="1" fill="#d1d5db" />
                          <rect x="6" y="38" width="88" height="3" rx="1" fill="#e5e7eb" />
                          <rect x="6" y="44" width="88" height="3" rx="1" fill="#e5e7eb" />
                          <rect x="6" y="50" width="88" height="3" rx="1" fill="#e5e7eb" />
                          <rect
                            x="60"
                            y="58"
                            width="34"
                            height="5"
                            rx="1"
                            fill={invoiceColor}
                            opacity="0.6"
                          />
                        </>
                      )}
                      {tpl.value === 'modern' && (
                        <>
                          <rect width="100" height="70" rx="4" fill="#f9fafb" />
                          <rect width="100" height="20" rx="4" fill={invoiceColor} />
                          <rect x="0" y="16" width="100" height="4" fill={invoiceColor} />
                          <rect
                            x="6"
                            y="5"
                            width="24"
                            height="10"
                            rx="2"
                            fill="white"
                            opacity="0.8"
                          />
                          <rect
                            x="66"
                            y="5"
                            width="28"
                            height="10"
                            rx="2"
                            fill="white"
                            opacity="0.6"
                          />
                          <rect x="6" y="28" width="60" height="4" rx="1" fill="#d1d5db" />
                          <rect x="6" y="36" width="88" height="3" rx="1" fill="#e5e7eb" />
                          <rect x="6" y="42" width="88" height="3" rx="1" fill="#e5e7eb" />
                          <rect x="6" y="48" width="88" height="3" rx="1" fill="#e5e7eb" />
                          <rect
                            x="60"
                            y="58"
                            width="34"
                            height="5"
                            rx="1"
                            fill={invoiceColor}
                            opacity="0.6"
                          />
                        </>
                      )}
                      {tpl.value === 'minimal' && (
                        <>
                          <rect width="100" height="70" rx="4" fill="#f9fafb" />
                          <rect
                            x="6"
                            y="8"
                            width="40"
                            height="7"
                            rx="2"
                            fill={invoiceColor}
                            opacity="0.9"
                          />
                          <rect
                            x="6"
                            y="18"
                            width="88"
                            height="2"
                            fill={invoiceColor}
                            opacity="0.4"
                          />
                          <rect x="6" y="28" width="50" height="4" rx="1" fill="#d1d5db" />
                          <rect x="6" y="36" width="88" height="3" rx="1" fill="#e5e7eb" />
                          <rect x="6" y="42" width="88" height="3" rx="1" fill="#e5e7eb" />
                          <rect x="6" y="48" width="88" height="3" rx="1" fill="#e5e7eb" />
                          <rect
                            x="60"
                            y="58"
                            width="34"
                            height="5"
                            rx="1"
                            fill={invoiceColor}
                            opacity="0.6"
                          />
                        </>
                      )}
                    </svg>
                    <p
                      className="text-center text-[13px] font-medium"
                      style={{ color: invoiceTemplate === tpl.value ? invoiceColor : '#374151' }}
                    >
                      {tpl.label}
                    </p>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="primary"
                size="sm"
                loading={updateMutation.isPending}
                onClick={handleSaveInvoiceSettings}
              >
                Spara fakturainställningar
              </Button>
              {invoiceSavedFlash && (
                <span className="text-[13px] font-medium text-emerald-600">Sparat!</span>
              )}
            </div>
          </section>

          {/* ── Section 4: Företagsinformation (read-only) ──────────────────── */}
          <section className="rounded-2xl border border-[#EAEDF0] bg-white p-5">
            <h2 className="mb-4 text-[14px] font-semibold text-gray-800">Företagsinformation</h2>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {[
                { label: 'Företagsnamn', value: org?.name ?? '–' },
                { label: 'Organisationsnummer', value: org?.orgNumber ?? '–' },
                { label: 'E-post', value: org?.email ?? '–' },
                {
                  label: 'Adress',
                  value: org?.address
                    ? `${org.address.street}, ${org.address.postalCode} ${org.address.city}`
                    : '–',
                },
              ].map((row) => (
                <div key={row.label} className="rounded-xl bg-gray-50 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                    {row.label}
                  </p>
                  <p className="mt-0.5 text-[13px] text-gray-600">{row.value}</p>
                </div>
              ))}
            </div>
          </section>

          {/* ── Section 5: AI-inställningar ─────────────────────────────────── */}
          <section className="rounded-2xl border border-[#EAEDF0] bg-white p-5">
            <div className="mb-4 flex items-center gap-2">
              <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-purple-50">
                <Brain size={13} strokeWidth={1.8} className="text-purple-600" />
              </div>
              <h2 className="text-[14px] font-semibold text-gray-800">AI-assistent</h2>
            </div>

            <div className="space-y-4">
              {/* Morning report toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[13.5px] font-medium text-gray-800">
                    Morgonrapport via e-post
                  </p>
                  <p className="text-[12px] text-gray-500">
                    Få en daglig sammanfattning måndag–fredag kl 07:00
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleMorningReportToggle(!morningReportEnabled)}
                  className={cn(
                    'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                    morningReportEnabled ? 'bg-blue-600' : 'bg-gray-200',
                  )}
                >
                  <span
                    className={cn(
                      'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                      morningReportEnabled ? 'translate-x-6' : 'translate-x-1',
                    )}
                  />
                </button>
              </div>

              {/* AI memories toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[13.5px] font-medium text-gray-800">AI-minnen</p>
                  <p className="text-[12px] text-gray-500">
                    AI:n kommer ihåg dina preferenser mellan samtal
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleAiMemoriesToggle(!aiMemoriesEnabled)}
                  className={cn(
                    'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                    aiMemoriesEnabled ? 'bg-blue-600' : 'bg-gray-200',
                  )}
                >
                  <span
                    className={cn(
                      'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                      aiMemoriesEnabled ? 'translate-x-6' : 'translate-x-1',
                    )}
                  />
                </button>
              </div>

              {/* Clear memories */}
              <div className="border-t border-[#EAEDF0] pt-4">
                {clearMemoriesConfirm ? (
                  <div className="space-y-2">
                    <p className="text-[13px] text-gray-700">
                      Vill du radera alla AI-minnen? AI:n kommer inte längre komma ihåg dina
                      preferenser.
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="primary"
                        size="sm"
                        loading={clearMemoriesLoading}
                        onClick={() => void handleClearMemories()}
                        className="!bg-red-600 hover:!bg-red-700"
                      >
                        Ja, radera
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setClearMemoriesConfirm(false)}
                        disabled={clearMemoriesLoading}
                      >
                        Avbryt
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setClearMemoriesConfirm(true)}
                    >
                      Rensa AI-minnen
                    </Button>
                    {clearMemoriesFlash && (
                      <span className="text-[13px] font-medium text-emerald-600">
                        Minnen raderade
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Info box */}
              <div className="flex items-start gap-2.5 rounded-xl bg-blue-50 p-3.5">
                <Info size={14} strokeWidth={1.8} className="mt-0.5 flex-shrink-0 text-blue-600" />
                <p className="text-[12.5px] text-blue-700">
                  AI-assistenten använder din organisations data för att svara på frågor och utföra
                  åtgärder. All data stannar inom din organisation och delas aldrig med andra.
                </p>
              </div>
            </div>
          </section>
        </div>
      )}
    </PageWrapper>
  )
}
