import React, { useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { FileText, Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { EmptyState } from '@/components/ui/EmptyState'
import { useCreateContractBatch } from './hooks/useContractBatch'
import { formatBytes } from './format'

export function ContractBatchUploadPage() {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const create = useCreateContractBatch()

  function addFiles(list: FileList | null) {
    if (!list) return
    const picked = Array.from(list).filter((f) => f.type === 'application/pdf')
    setFiles((prev) => [...prev, ...picked])
  }

  function removeFile(i: number) {
    setFiles((prev) => prev.filter((_, idx) => idx !== i))
  }

  async function submit() {
    if (files.length === 0) return
    const res = await create.mutateAsync(files)
    void navigate({ to: '/import/contract-batches/$batchId', params: { batchId: res.id } })
  }

  return (
    <PageWrapper id="contract-batch-upload">
      <PageHeader
        title="Batch-skanna kontrakt"
        description="Ladda upp flera hyreskontrakt (PDF). Systemet skannar dem och föreslår en enhet per kontrakt — du granskar och godkänner innan något avtal skapas."
        action={
          <Button
            variant="primary"
            onClick={submit}
            disabled={files.length === 0 || create.isPending}
          >
            {create.isPending ? 'Skapar…' : `Skapa batch (${files.length})`}
          </Button>
        }
      />

      <div className="border-line mt-6 rounded-2xl border bg-white p-5">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[#DDDFE4] py-10 text-gray-500 transition-colors hover:border-blue-400 hover:bg-blue-50/40"
        >
          <Upload size={24} strokeWidth={1.8} />
          <span className="text-[13.5px] font-medium text-gray-700">Välj PDF-filer</span>
          <span className="text-[12px] text-gray-400">Endast PDF, max 10 MB per fil</span>
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files)
            e.target.value = ''
          }}
        />

        <div className="mt-4">
          {files.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="Inga filer valda"
              description="Lägg till kontrakts-PDF:er för att skapa en skanningsbatch."
            />
          ) : (
            <ul className="space-y-1.5">
              {files.map((f, i) => (
                <li
                  key={`${f.name}-${i}`}
                  className="border-line flex items-center justify-between rounded-lg border px-3 py-2"
                >
                  <span className="flex items-center gap-2 text-[13px] text-gray-700">
                    <FileText size={14} className="text-gray-400" />
                    {f.name}
                    <span className="text-[12px] text-gray-400">{formatBytes(f.size)}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => removeFile(i)}
                    className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                    aria-label="Ta bort"
                  >
                    <X size={15} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </PageWrapper>
  )
}
