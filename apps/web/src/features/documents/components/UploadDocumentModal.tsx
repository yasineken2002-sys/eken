import { useState, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Upload, FileText, X, CheckCircle } from 'lucide-react'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { useUploadDocument } from '../hooks/useDocuments'
import { cn } from '@/lib/cn'

interface Props {
  open: boolean
  onClose: () => void
  propertyId?: string
  unitId?: string
  leaseId?: string
  tenantId?: string
}

const ACCEPTED_TYPES = '.pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.webp'
const MAX_SIZE = 20 * 1024 * 1024

const CATEGORY_OPTIONS = [
  { value: 'CONTRACT', label: 'Kontrakt' },
  { value: 'INSPECTION', label: 'Besiktning' },
  { value: 'DRAWING', label: 'Ritning' },
  { value: 'PHOTO', label: 'Foto' },
  { value: 'INVOICE', label: 'Faktura' },
  { value: 'INSURANCE', label: 'Försäkring' },
  { value: 'OTHER', label: 'Övrigt' },
]

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fileNameWithoutExt(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

export function UploadDocumentModal({
  open,
  onClose,
  propertyId,
  unitId,
  leaseId,
  tenantId,
}: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [category, setCategory] = useState('OTHER')
  const [description, setDescription] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [sizeError, setSizeError] = useState(false)
  const [success, setSuccess] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const uploadMutation = useUploadDocument()

  const reset = () => {
    setFile(null)
    setName('')
    setCategory('OTHER')
    setDescription('')
    setSizeError(false)
    setSuccess(false)
  }

  const handleClose = () => {
    reset()
    onClose()
  }

  const selectFile = (f: File) => {
    if (f.size > MAX_SIZE) {
      setSizeError(true)
      return
    }
    setSizeError(false)
    setFile(f)
    if (!name) setName(fileNameWithoutExt(f.name))
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const f = e.dataTransfer.files[0]
    if (f) selectFile(f)
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) selectFile(f)
  }

  const handleSubmit = () => {
    if (!file || !name.trim()) return

    uploadMutation.mutate(
      {
        file,
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        category,
        ...(propertyId ? { propertyId } : {}),
        ...(unitId ? { unitId } : {}),
        ...(leaseId ? { leaseId } : {}),
        ...(tenantId ? { tenantId } : {}),
      },
      {
        onSuccess: () => {
          setSuccess(true)
          setTimeout(() => {
            handleClose()
          }, 1200)
        },
      },
    )
  }

  const inputBase =
    'h-9 w-full rounded-lg border border-[#DDDFE4] px-3 text-[13.5px] text-gray-900 placeholder-gray-400 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20'

  return (
    <Modal open={open} onClose={handleClose} title="Ladda upp dokument" size="md">
      <AnimatePresence mode="wait">
        {success ? (
          <motion.div
            key="success"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center py-10 text-center"
          >
            <CheckCircle size={40} className="mb-3 text-emerald-500" strokeWidth={1.5} />
            <p className="text-[15px] font-semibold text-gray-900">Uppladdning klar!</p>
            <p className="mt-1 text-[13px] text-gray-500">Dokumentet har sparats.</p>
          </motion.div>
        ) : (
          <motion.div
            key="form"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="space-y-4"
          >
            {/* Drop zone */}
            {!file ? (
              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragOver(true)
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                className={cn(
                  'flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed py-10 transition-colors',
                  dragOver
                    ? 'border-blue-400 bg-blue-50'
                    : 'border-[#DDDFE4] hover:border-blue-300 hover:bg-gray-50',
                )}
              >
                <Upload
                  size={24}
                  strokeWidth={1.5}
                  className={cn('mb-2', dragOver ? 'text-blue-500' : 'text-gray-300')}
                />
                <p className="text-[13.5px] font-medium text-gray-700">Dra och släpp en fil hit</p>
                <p className="mt-1 text-[12px] text-gray-400">eller klicka för att välja fil</p>
                <p className="mt-2 text-[11px] text-gray-300">
                  PDF, Word, Excel, JPG, PNG — max 20 MB
                </p>
                {sizeError && (
                  <p className="mt-2 text-[12px] font-medium text-red-600">
                    Filen är för stor. Maximal filstorlek är 20 MB.
                  </p>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-3 rounded-xl border border-[#EAEDF0] bg-gray-50/60 px-4 py-3">
                <FileText size={20} strokeWidth={1.8} className="flex-shrink-0 text-blue-500" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-gray-900">{file.name}</p>
                  <p className="text-[12px] text-gray-400">{formatFileSize(file.size)}</p>
                </div>
                <button
                  onClick={() => {
                    setFile(null)
                    setSizeError(false)
                  }}
                  className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-gray-400 hover:bg-gray-200 hover:text-gray-600"
                >
                  <X size={13} />
                </button>
              </div>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_TYPES}
              className="hidden"
              onChange={handleFileChange}
            />

            {/* Name */}
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-gray-700">Namn *</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Dokument­namn"
                className={inputBase}
              />
            </div>

            {/* Category */}
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-gray-700">Kategori</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className={cn(inputBase, 'cursor-pointer bg-white')}
              >
                {CATEGORY_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Description */}
            <div>
              <label className="mb-1.5 block text-[13px] font-medium text-gray-700">
                Beskrivning <span className="font-normal text-gray-400">(valfritt)</span>
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Lägg till en beskrivning…"
                rows={2}
                className={cn(inputBase, 'h-auto resize-none py-2.5 leading-relaxed')}
              />
            </div>

            <ModalFooter>
              <Button
                variant="secondary"
                size="sm"
                onClick={handleClose}
                disabled={uploadMutation.isPending}
              >
                Avbryt
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={uploadMutation.isPending}
                disabled={!file || !name.trim()}
                onClick={handleSubmit}
              >
                {uploadMutation.isPending ? 'Laddar upp…' : 'Ladda upp'}
              </Button>
            </ModalFooter>
          </motion.div>
        )}
      </AnimatePresence>
    </Modal>
  )
}
