import { useState } from 'react'
import { motion } from 'framer-motion'
import { FileText, File, Image, Upload, Download, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useDocuments, useDeleteDocument } from '../hooks/useDocuments'
import { downloadDocument } from '../api/documents.api'
import { UploadDocumentModal } from './UploadDocumentModal'
import { formatDate } from '@eken/shared'

interface Props {
  propertyId?: string
  unitId?: string
  leaseId?: string
  tenantId?: string
  title?: string
  allowUpload?: boolean
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const CATEGORY_LABELS: Record<string, string> = {
  CONTRACT: 'Kontrakt',
  INSPECTION: 'Besiktning',
  DRAWING: 'Ritning',
  PHOTO: 'Foto',
  INVOICE: 'Faktura',
  INSURANCE: 'Försäkring',
  OTHER: 'Övrigt',
}

function FileIcon({ mimeType }: { mimeType: string }) {
  if (mimeType === 'application/pdf') {
    return <FileText size={18} strokeWidth={1.8} className="text-red-500" />
  }
  if (
    mimeType === 'application/msword' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return <FileText size={18} strokeWidth={1.8} className="text-blue-500" />
  }
  if (
    mimeType === 'application/vnd.ms-excel' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    return <FileText size={18} strokeWidth={1.8} className="text-green-600" />
  }
  if (mimeType.startsWith('image/')) {
    return <Image size={18} strokeWidth={1.8} className="text-purple-500" />
  }
  return <File size={18} strokeWidth={1.8} className="text-gray-400" />
}

export function DocumentList({
  propertyId,
  unitId,
  leaseId,
  tenantId,
  title = 'Dokument',
  allowUpload = true,
}: Props) {
  const [showUpload, setShowUpload] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const { data: documents = [], isLoading } = useDocuments({
    ...(propertyId ? { propertyId } : {}),
    ...(unitId ? { unitId } : {}),
    ...(leaseId ? { leaseId } : {}),
    ...(tenantId ? { tenantId } : {}),
  })

  const deleteMutation = useDeleteDocument()

  const handleDelete = (id: string) => {
    deleteMutation.mutate(id, { onSuccess: () => setConfirmDeleteId(null) })
  }

  return (
    <div>
      {/* Section header */}
      <div className="mb-3 flex items-center gap-3">
        <p className="shrink-0 text-[12px] font-semibold uppercase tracking-wide text-gray-400">
          {title}
        </p>
        <div className="h-px flex-1 bg-[#EAEDF0]" />
        <span className="text-[12px] text-gray-400">{documents.length}</span>
        {allowUpload && (
          <Button variant="secondary" size="xs" onClick={() => setShowUpload(true)}>
            <Upload size={12} strokeWidth={1.8} />
            Ladda upp
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg bg-gray-100" />
          ))}
        </div>
      ) : documents.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <FileText size={24} strokeWidth={1.5} className="mb-2 text-gray-200" />
          <p className="text-[13px] text-gray-400">Inga dokument uppladdade</p>
          {allowUpload && (
            <Button
              variant="secondary"
              size="xs"
              className="mt-2"
              onClick={() => setShowUpload(true)}
            >
              <Upload size={12} strokeWidth={1.8} />
              Ladda upp
            </Button>
          )}
        </div>
      ) : (
        <motion.div
          className="space-y-2"
          initial="hidden"
          animate="show"
          variants={{ hidden: {}, show: { transition: { staggerChildren: 0.04 } } }}
        >
          {documents.map((doc) => (
            <motion.div
              key={doc.id}
              variants={{
                hidden: { opacity: 0, y: 6 },
                show: { opacity: 1, y: 0, transition: { duration: 0.18 } },
              }}
              className="flex items-start gap-3 rounded-lg border border-[#EAEDF0] bg-gray-50/60 px-3 py-2.5"
            >
              {/* Icon */}
              <div className="mt-0.5 flex-shrink-0">
                <FileIcon mimeType={doc.mimeType} />
              </div>

              {/* Info */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-[13px] font-medium text-gray-900">{doc.name}</p>
                  <span className="inline-flex flex-shrink-0 items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
                    {CATEGORY_LABELS[doc.category] ?? doc.category}
                  </span>
                </div>
                {doc.description && (
                  <p className="mt-0.5 truncate text-[12px] text-gray-500">{doc.description}</p>
                )}
                <p className="mt-0.5 text-[11.5px] text-gray-400">
                  Uppladdad av {doc.uploadedBy.firstName} {doc.uploadedBy.lastName}
                  {' · '}
                  {formatDate(doc.createdAt)}
                </p>
              </div>

              {/* Actions */}
              <div className="flex flex-shrink-0 items-center gap-2">
                <span className="text-[11.5px] text-gray-400">{formatFileSize(doc.fileSize)}</span>
                <button
                  onClick={() => downloadDocument(doc.id, doc.name)}
                  className="flex h-7 w-7 items-center justify-center rounded text-gray-400 transition-colors hover:bg-blue-50 hover:text-blue-600"
                  title="Ladda ner"
                >
                  <Download size={13} strokeWidth={1.8} />
                </button>
                {confirmDeleteId === doc.id ? (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleDelete(doc.id)}
                      disabled={deleteMutation.isPending}
                      className="rounded px-1.5 py-0.5 text-[11px] font-medium text-red-600 hover:bg-red-50"
                    >
                      {deleteMutation.isPending ? '…' : 'Ja'}
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      className="rounded px-1.5 py-0.5 text-[11px] font-medium text-gray-500 hover:bg-gray-100"
                    >
                      Avbryt
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmDeleteId(doc.id)}
                    className="flex h-7 w-7 items-center justify-center rounded text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500"
                    title="Ta bort"
                  >
                    <Trash2 size={13} strokeWidth={1.8} />
                  </button>
                )}
              </div>
            </motion.div>
          ))}
        </motion.div>
      )}

      <UploadDocumentModal
        open={showUpload}
        onClose={() => setShowUpload(false)}
        {...(propertyId ? { propertyId } : {})}
        {...(unitId ? { unitId } : {})}
        {...(leaseId ? { leaseId } : {})}
        {...(tenantId ? { tenantId } : {})}
      />
    </div>
  )
}
