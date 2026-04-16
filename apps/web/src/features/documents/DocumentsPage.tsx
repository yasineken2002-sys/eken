import { useState, useMemo } from 'react'
import { motion } from 'framer-motion'
import {
  FolderOpen,
  FileText,
  File,
  Image,
  HardDrive,
  Clock,
  Download,
  Trash2,
  Search,
  Plus,
} from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { StatCard } from '@/components/ui/StatCard'
import { EmptyState } from '@/components/ui/EmptyState'
import { DataTable } from '@/components/ui/DataTable'
import { useDocuments, useDeleteDocument } from './hooks/useDocuments'
import { downloadDocument } from './api/documents.api'
import { UploadDocumentModal } from './components/UploadDocumentModal'
import { formatDate } from '@eken/shared'
import type { Document } from './api/documents.api'

const container = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } }
const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
}

const CATEGORY_OPTIONS = [
  { value: '', label: 'Alla kategorier' },
  { value: 'CONTRACT', label: 'Kontrakt' },
  { value: 'INSPECTION', label: 'Besiktning' },
  { value: 'DRAWING', label: 'Ritning' },
  { value: 'PHOTO', label: 'Foto' },
  { value: 'INVOICE', label: 'Faktura' },
  { value: 'INSURANCE', label: 'Försäkring' },
  { value: 'OTHER', label: 'Övrigt' },
]

const CATEGORY_LABELS: Record<string, string> = {
  CONTRACT: 'Kontrakt',
  INSPECTION: 'Besiktning',
  DRAWING: 'Ritning',
  PHOTO: 'Foto',
  INVOICE: 'Faktura',
  INSURANCE: 'Försäkring',
  OTHER: 'Övrigt',
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function FileTypeIcon({ mimeType }: { mimeType: string }) {
  if (mimeType === 'application/pdf') {
    return <FileText size={14} strokeWidth={1.8} className="text-red-500" />
  }
  if (
    mimeType === 'application/msword' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return <FileText size={14} strokeWidth={1.8} className="text-blue-500" />
  }
  if (
    mimeType === 'application/vnd.ms-excel' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    return <FileText size={14} strokeWidth={1.8} className="text-green-600" />
  }
  if (mimeType.startsWith('image/')) {
    return <Image size={14} strokeWidth={1.8} className="text-purple-500" />
  }
  return <File size={14} strokeWidth={1.8} className="text-gray-400" />
}

function fileExtension(mimeType: string): string {
  const map: Record<string, string> = {
    'application/pdf': 'PDF',
    'application/msword': 'DOC',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
    'application/vnd.ms-excel': 'XLS',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
    'image/jpeg': 'JPG',
    'image/png': 'PNG',
    'image/webp': 'WEBP',
  }
  return map[mimeType] ?? mimeType.split('/').pop()?.toUpperCase() ?? '?'
}

function linkedTo(doc: Document): string {
  if (doc.property) return `Fastighet: ${doc.property.name}`
  if (doc.unit) return `Enhet: ${doc.unit.name}`
  if (doc.lease) return `Kontrakt: ${doc.lease.id.slice(0, 8)}…`
  if (doc.tenant) {
    const name =
      doc.tenant.type === 'INDIVIDUAL'
        ? [doc.tenant.firstName, doc.tenant.lastName].filter(Boolean).join(' ')
        : (doc.tenant.companyName ?? '–')
    return `Hyresgäst: ${name}`
  }
  return '–'
}

export function DocumentsPage() {
  const [showUpload, setShowUpload] = useState(false)
  const [categoryFilter, setCategoryFilter] = useState('')
  const [search, setSearch] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const { data: documents = [], isLoading } = useDocuments(
    categoryFilter ? { category: categoryFilter } : undefined,
  )

  const deleteMutation = useDeleteDocument()

  const filtered = useMemo(() => {
    if (!search.trim()) return documents
    const q = search.toLowerCase()
    return documents.filter((d) => d.name.toLowerCase().includes(q))
  }, [documents, search])

  const totalSize = useMemo(() => documents.reduce((s, d) => s + d.fileSize, 0), [documents])

  const latestDate = useMemo(() => {
    if (documents.length === 0) return null
    return documents[0]?.createdAt ?? null
  }, [documents])

  const handleDelete = (id: string) => {
    deleteMutation.mutate(id, { onSuccess: () => setConfirmDeleteId(null) })
  }

  const columns = [
    {
      key: 'name',
      header: 'Namn',
      cell: (doc: Document) => (
        <div>
          <p className="font-medium text-gray-900">{doc.name}</p>
          <span className="mt-0.5 inline-block rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
            {CATEGORY_LABELS[doc.category] ?? doc.category}
          </span>
        </div>
      ),
    },
    {
      key: 'linked',
      header: 'Kopplat till',
      cell: (doc: Document) => <span className="text-[13px] text-gray-500">{linkedTo(doc)}</span>,
    },
    {
      key: 'type',
      header: 'Typ',
      cell: (doc: Document) => (
        <div className="flex items-center gap-1.5">
          <FileTypeIcon mimeType={doc.mimeType} />
          <span className="text-[12px] font-medium text-gray-500">
            {fileExtension(doc.mimeType)}
          </span>
        </div>
      ),
    },
    {
      key: 'size',
      header: 'Storlek',
      cell: (doc: Document) => (
        <span className="text-[13px] text-gray-500">{formatFileSize(doc.fileSize)}</span>
      ),
    },
    {
      key: 'uploaded',
      header: 'Uppladdad',
      cell: (doc: Document) => (
        <div>
          <p className="text-[13px] text-gray-700">{formatDate(doc.createdAt)}</p>
          <p className="text-[11.5px] text-gray-400">
            {doc.uploadedBy.firstName} {doc.uploadedBy.lastName}
          </p>
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      cell: (doc: Document) => (
        <div className="flex items-center gap-1.5">
          <button
            onClick={(e) => {
              e.stopPropagation()
              downloadDocument(doc.id, doc.name)
            }}
            className="flex h-7 w-7 items-center justify-center rounded text-gray-400 transition-colors hover:bg-blue-50 hover:text-blue-600"
            title="Ladda ner"
          >
            <Download size={13} strokeWidth={1.8} />
          </button>
          {confirmDeleteId === doc.id ? (
            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
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
              onClick={(e) => {
                e.stopPropagation()
                setConfirmDeleteId(doc.id)
              }}
              className="flex h-7 w-7 items-center justify-center rounded text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500"
              title="Ta bort"
            >
              <Trash2 size={13} strokeWidth={1.8} />
            </button>
          )}
        </div>
      ),
    },
  ]

  return (
    <PageWrapper id="documents">
      <PageHeader
        title="Dokument"
        description="Hantera dokument kopplade till fastigheter, enheter och kontrakt"
        action={
          <Button variant="primary" size="sm" onClick={() => setShowUpload(true)}>
            <Plus size={14} strokeWidth={2.2} />
            Ladda upp
          </Button>
        }
      />

      {/* Stats */}
      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3"
      >
        <motion.div variants={item}>
          <StatCard
            title="Totalt dokument"
            value={documents.length}
            icon={FolderOpen}
            iconColor="#2563EB"
            delay={0}
          />
        </motion.div>
        <motion.div variants={item}>
          <StatCard
            title="Lagringsutrymme"
            value={formatFileSize(totalSize)}
            icon={HardDrive}
            iconColor="#7C3AED"
            delay={0.05}
          />
        </motion.div>
        <motion.div variants={item}>
          <StatCard
            title="Senast uppladdad"
            value={latestDate ? formatDate(latestDate) : '–'}
            icon={Clock}
            iconColor="#059669"
            delay={0.1}
          />
        </motion.div>
      </motion.div>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search
            size={13}
            strokeWidth={1.8}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Sök dokument…"
            className="h-9 rounded-lg border border-[#E5E7EB] pl-8 pr-3 text-[13px] text-gray-900 placeholder-gray-400 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
            style={{ width: 220 }}
          />
        </div>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="h-9 cursor-pointer rounded-lg border border-[#E5E7EB] bg-white px-3 text-[13px] text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
        >
          {CATEGORY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="mt-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-20 text-[13px] text-gray-400">
            Laddar dokument…
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={FolderOpen}
            title="Inga dokument"
            description={
              documents.length === 0
                ? 'Ladda upp ditt första dokument för att komma igång.'
                : 'Inga dokument matchar sökningen.'
            }
            {...(documents.length === 0
              ? {
                  action: (
                    <Button variant="primary" onClick={() => setShowUpload(true)}>
                      <Plus size={14} strokeWidth={2.2} />
                      Ladda upp dokument
                    </Button>
                  ),
                }
              : {})}
          />
        ) : (
          <DataTable columns={columns} data={filtered} keyExtractor={(d) => d.id} />
        )}
      </div>

      <UploadDocumentModal open={showUpload} onClose={() => setShowUpload(false)} />
    </PageWrapper>
  )
}
