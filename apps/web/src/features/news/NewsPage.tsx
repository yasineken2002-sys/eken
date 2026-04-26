import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Newspaper,
  Globe,
  Building2,
  Calendar,
  Pencil,
  Trash2,
  Send,
  Plus,
  X,
  Check,
} from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { StatCard } from '@/components/ui/StatCard'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { EmptyState } from '@/components/ui/EmptyState'
import {
  useNewsPosts,
  useCreateNewsPost,
  useUpdateNewsPost,
  usePublishNewsPost,
  useDeleteNewsPost,
} from './hooks/useNews'
import { useQuery } from '@tanstack/react-query'
import { fetchProperties } from '@/features/properties/api/properties.api'
import { formatDate } from '@eken/shared'
import { cn } from '@/lib/cn'
import type { NewsPost, CreateNewsPostDto } from './api/news.api'

const container = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } }
const itemAnim = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
}

type Tab = 'all' | 'published' | 'draft'

function StatusBadge({ published }: { published: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] font-medium',
        published ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-600',
      )}
    >
      <span
        className={cn('h-1.5 w-1.5 rounded-full', published ? 'bg-emerald-500' : 'bg-gray-400')}
      />
      {published ? 'Publicerad' : 'Utkast'}
    </span>
  )
}

function TargetLabel({ post }: { post: NewsPost }) {
  if (post.targetAll) {
    return (
      <span className="flex items-center gap-1 text-[13px] text-gray-600">
        <Globe size={12} strokeWidth={1.8} className="text-blue-500" />
        Alla hyresgäster
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1 text-[13px] text-gray-600">
      <Building2 size={12} strokeWidth={1.8} className="text-violet-500" />
      {post.property?.name ? `Fastighet: ${post.property.name}` : 'Specifik fastighet'}
    </span>
  )
}

interface PostFormState {
  title: string
  content: string
  targetAll: boolean
  propertyId: string
}

const defaultForm: PostFormState = { title: '', content: '', targetAll: true, propertyId: '' }

function PostForm({
  value,
  onChange,
  properties,
}: {
  value: PostFormState
  onChange: (v: PostFormState) => void
  properties: Array<{ id: string; name: string }>
}) {
  return (
    <div className="space-y-4">
      <div>
        <label className="mb-1.5 block text-[13px] font-medium text-gray-700">Titel *</label>
        <input
          type="text"
          value={value.title}
          onChange={(e) => onChange({ ...value, title: e.target.value })}
          placeholder="Rubrik på nyheten"
          className="h-9 w-full rounded-lg border border-[#DDDFE4] px-3 text-[13.5px] text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
        />
      </div>
      <div>
        <label className="mb-1.5 block text-[13px] font-medium text-gray-700">Innehåll *</label>
        <textarea
          value={value.content}
          onChange={(e) => onChange({ ...value, content: e.target.value })}
          placeholder="Skriv nyhetsinnehållet här…"
          rows={8}
          className="w-full resize-none rounded-lg border border-[#DDDFE4] px-3 py-2.5 text-[13.5px] text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
        />
      </div>
      <div>
        <label className="mb-2 block text-[13px] font-medium text-gray-700">Målgrupp</label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onChange({ ...value, targetAll: true, propertyId: '' })}
            className={cn(
              'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-all',
              value.targetAll
                ? 'border-blue-500 bg-blue-50 text-blue-700'
                : 'border-[#DDDFE4] bg-white text-gray-600 hover:bg-gray-50',
            )}
          >
            {value.targetAll && <Check size={12} strokeWidth={2.5} />}
            <Globe size={13} strokeWidth={1.8} />
            Alla hyresgäster
          </button>
          <button
            type="button"
            onClick={() => onChange({ ...value, targetAll: false })}
            className={cn(
              'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-all',
              !value.targetAll
                ? 'border-blue-500 bg-blue-50 text-blue-700'
                : 'border-[#DDDFE4] bg-white text-gray-600 hover:bg-gray-50',
            )}
          >
            {!value.targetAll && <Check size={12} strokeWidth={2.5} />}
            <Building2 size={13} strokeWidth={1.8} />
            Specifik fastighet
          </button>
        </div>
      </div>
      {!value.targetAll && (
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-gray-700">Fastighet</label>
          <select
            value={value.propertyId}
            onChange={(e) => onChange({ ...value, propertyId: e.target.value })}
            className="h-9 w-full rounded-lg border border-[#DDDFE4] px-3 text-[13.5px] text-gray-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          >
            <option value="">Välj fastighet…</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}

export function NewsPage() {
  const { data: posts = [], isLoading } = useNewsPosts()
  const { data: propertiesRaw = [] } = useQuery({
    queryKey: ['properties', 'list'],
    queryFn: fetchProperties,
    staleTime: 60_000,
  })
  const properties = propertiesRaw.map((p) => ({ id: p.id, name: p.name }))

  const createMutation = useCreateNewsPost()
  const updateMutation = useUpdateNewsPost()
  const publishMutation = usePublishNewsPost()
  const deleteMutation = useDeleteNewsPost()

  const [tab, setTab] = useState<Tab>('all')
  const [createOpen, setCreateOpen] = useState(false)
  const [createForm, setCreateForm] = useState<PostFormState>(defaultForm)
  const [selectedPost, setSelectedPost] = useState<NewsPost | null>(null)
  const [editForm, setEditForm] = useState<PostFormState>(defaultForm)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)

  const published = posts.filter((p) => p.publishedAt !== null)
  const drafts = posts.filter((p) => p.publishedAt === null)

  const filtered = tab === 'all' ? posts : tab === 'published' ? published : drafts

  function openEdit(post: NewsPost) {
    setSelectedPost(post)
    setEditForm({
      title: post.title,
      content: post.content,
      targetAll: post.targetAll,
      propertyId: post.propertyId ?? '',
    })
  }

  function closeEdit() {
    setSelectedPost(null)
  }

  async function handleCreate(publish: boolean) {
    if (!createForm.title.trim() || !createForm.content.trim()) return
    const dto: CreateNewsPostDto = {
      title: createForm.title,
      content: createForm.content,
      targetAll: createForm.targetAll,
      propertyId: createForm.targetAll ? null : createForm.propertyId || null,
    }
    const created = await createMutation.mutateAsync(dto)
    if (publish) {
      await publishMutation.mutateAsync(created.id)
    }
    setCreateOpen(false)
    setCreateForm(defaultForm)
  }

  async function handleSaveEdit() {
    if (!selectedPost) return
    await updateMutation.mutateAsync({
      id: selectedPost.id,
      dto: {
        title: editForm.title,
        content: editForm.content,
        targetAll: editForm.targetAll,
        propertyId: editForm.targetAll ? null : editForm.propertyId || null,
      },
    })
    closeEdit()
  }

  async function handlePublishEdit() {
    if (!selectedPost) return
    await updateMutation.mutateAsync({
      id: selectedPost.id,
      dto: {
        title: editForm.title,
        content: editForm.content,
        targetAll: editForm.targetAll,
        propertyId: editForm.targetAll ? null : editForm.propertyId || null,
      },
    })
    await publishMutation.mutateAsync(selectedPost.id)
    closeEdit()
  }

  async function handlePublishRow(id: string) {
    await publishMutation.mutateAsync(id)
  }

  async function handleDelete(id: string) {
    await deleteMutation.mutateAsync(id)
    setDeleteConfirm(null)
    if (selectedPost?.id === id) closeEdit()
  }

  const isMutating =
    createMutation.isPending ||
    updateMutation.isPending ||
    publishMutation.isPending ||
    deleteMutation.isPending

  return (
    <PageWrapper id="news">
      <PageHeader
        title="Nyheter"
        description="Publicera nyheter till dina hyresgäster"
        action={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus size={14} strokeWidth={2} />
            Nytt inlägg
          </Button>
        }
      />

      {/* Stat cards */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          title="Publicerade"
          value={published.length}
          icon={Send}
          iconColor="#059669"
          delay={0}
        />
        <StatCard
          title="Utkast"
          value={drafts.length}
          icon={Newspaper}
          iconColor="#6B7280"
          delay={0.05}
        />
        <StatCard
          title="Totalt"
          value={posts.length}
          icon={Calendar}
          iconColor="#2563EB"
          delay={0.1}
        />
      </div>

      {/* Filter tabs */}
      <div className="mt-6">
        <div className="flex w-fit gap-1 rounded-xl bg-gray-100 p-1">
          {(
            [
              ['all', 'Alla'],
              ['published', 'Publicerade'],
              ['draft', 'Utkast'],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cn(
                'h-8 rounded-lg px-3 text-[13px] font-medium transition-all',
                tab === id
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Layout: table + detail panel */}
      <div className="mt-4 flex gap-4">
        {/* Table */}
        <div
          className={cn(
            'min-w-0 flex-1 transition-all',
            selectedPost ? 'max-w-[calc(100%-400px)]' : '',
          )}
        >
          {isLoading ? (
            <div className="flex h-32 items-center justify-center text-[13px] text-gray-400">
              Laddar…
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Newspaper}
              title="Inga inlägg"
              description="Skapa ditt första nyhetsinlägg för hyresgästerna"
              action={
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  <Plus size={14} strokeWidth={2} />
                  Nytt inlägg
                </Button>
              }
            />
          ) : (
            <div className="overflow-hidden rounded-2xl border border-[#EAEDF0] bg-white">
              <table className="w-full">
                <thead>
                  <tr style={{ borderBottom: '1px solid #EAEDF0' }}>
                    <th className="px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                      Titel
                    </th>
                    <th className="px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                      Målgrupp
                    </th>
                    <th className="px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                      Skapad
                    </th>
                    <th className="px-5 py-3 text-left text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                      Status
                    </th>
                    <th className="px-5 py-3 text-right text-[12px] font-semibold uppercase tracking-wide text-gray-400">
                      Åtgärder
                    </th>
                  </tr>
                </thead>
                <motion.tbody variants={container} initial="hidden" animate="show">
                  {filtered.map((post) => (
                    <motion.tr
                      key={post.id}
                      variants={itemAnim}
                      onClick={() => openEdit(post)}
                      className={cn(
                        'cursor-pointer border-b border-[#EAEDF0] transition-colors last:border-0 hover:bg-gray-50/80',
                        selectedPost?.id === post.id && 'bg-blue-50/60',
                      )}
                    >
                      <td className="px-5 py-3.5">
                        <p className="text-[13.5px] font-medium text-gray-900">{post.title}</p>
                        <p className="mt-0.5 line-clamp-1 text-[12px] text-gray-400">
                          {post.content}
                        </p>
                      </td>
                      <td className="px-5 py-3.5">
                        <TargetLabel post={post} />
                      </td>
                      <td className="px-5 py-3.5 text-[13px] text-gray-500">
                        {formatDate(post.createdAt)}
                      </td>
                      <td className="px-5 py-3.5">
                        <StatusBadge published={post.publishedAt !== null} />
                      </td>
                      <td className="px-5 py-3.5">
                        <div
                          className="flex items-center justify-end gap-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {post.publishedAt === null && (
                            <Button
                              size="xs"
                              variant="outline"
                              loading={
                                publishMutation.isPending && publishMutation.variables === post.id
                              }
                              onClick={() => handlePublishRow(post.id)}
                            >
                              <Send size={11} strokeWidth={2} />
                              Publicera
                            </Button>
                          )}
                          <Button size="xs" variant="ghost" onClick={() => openEdit(post)}>
                            <Pencil size={11} strokeWidth={2} />
                            Redigera
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            className="text-red-500 hover:bg-red-50 hover:text-red-600"
                            onClick={() => setDeleteConfirm(post.id)}
                          >
                            <Trash2 size={11} strokeWidth={2} />
                            Radera
                          </Button>
                        </div>
                      </td>
                    </motion.tr>
                  ))}
                </motion.tbody>
              </table>
            </div>
          )}
        </div>

        {/* Detail / edit panel */}
        <AnimatePresence>
          {selectedPost && (
            <motion.div
              key="detail"
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 16 }}
              transition={{ type: 'spring', stiffness: 360, damping: 32 }}
              className="w-[380px] flex-shrink-0"
            >
              <div className="rounded-2xl border border-[#EAEDF0] bg-white">
                <div className="flex items-center justify-between border-b border-[#EAEDF0] px-5 py-4">
                  <p className="text-[15px] font-semibold text-gray-900">Redigera inlägg</p>
                  <button
                    onClick={closeEdit}
                    className="flex h-7 w-7 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                  >
                    <X size={14} strokeWidth={2} />
                  </button>
                </div>
                <div className="p-5">
                  <PostForm value={editForm} onChange={setEditForm} properties={properties} />

                  {selectedPost.publishedAt !== null && (
                    <div className="mt-4 flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2">
                      <Send size={12} strokeWidth={2} className="text-emerald-600" />
                      <span className="text-[12px] text-emerald-700">
                        Publicerad {formatDate(selectedPost.publishedAt)} · Synlig för hyresgästerna
                        i portalen
                      </span>
                    </div>
                  )}

                  <div className="mt-5 flex gap-2 border-t border-[#EAEDF0] pt-4">
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={updateMutation.isPending}
                      disabled={isMutating}
                      onClick={() => void handleSaveEdit()}
                      className="flex-1"
                    >
                      Spara utkast
                    </Button>
                    {selectedPost.publishedAt === null && (
                      <Button
                        variant="primary"
                        size="sm"
                        loading={publishMutation.isPending}
                        disabled={isMutating}
                        onClick={() => void handlePublishEdit()}
                        className="flex-1"
                      >
                        <Send size={12} strokeWidth={2} />
                        Publicera nu
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Create modal */}
      <Modal
        open={createOpen}
        onClose={() => {
          setCreateOpen(false)
          setCreateForm(defaultForm)
        }}
        title="Nytt inlägg"
        description="Skriv och publicera en nyhet till dina hyresgäster"
        size="md"
      >
        <PostForm value={createForm} onChange={setCreateForm} properties={properties} />
        <ModalFooter>
          <Button
            variant="secondary"
            onClick={() => {
              setCreateOpen(false)
              setCreateForm(defaultForm)
            }}
          >
            Avbryt
          </Button>
          <Button
            variant="secondary"
            loading={createMutation.isPending && !publishMutation.isPending}
            disabled={isMutating || !createForm.title.trim() || !createForm.content.trim()}
            onClick={() => void handleCreate(false)}
          >
            Spara som utkast
          </Button>
          <Button
            variant="primary"
            loading={createMutation.isPending || publishMutation.isPending}
            disabled={isMutating || !createForm.title.trim() || !createForm.content.trim()}
            onClick={() => void handleCreate(true)}
          >
            <Send size={13} strokeWidth={2} />
            Publicera direkt
          </Button>
        </ModalFooter>
      </Modal>

      {/* Delete confirm modal */}
      <Modal
        open={deleteConfirm !== null}
        onClose={() => setDeleteConfirm(null)}
        title="Radera inlägg"
        description="Är du säker? Åtgärden kan inte ångras."
        size="sm"
      >
        <ModalFooter>
          <Button variant="secondary" onClick={() => setDeleteConfirm(null)}>
            Avbryt
          </Button>
          <Button
            variant="danger"
            loading={deleteMutation.isPending}
            onClick={() => deleteConfirm && void handleDelete(deleteConfirm)}
          >
            <Trash2 size={13} strokeWidth={2} />
            Radera
          </Button>
        </ModalFooter>
      </Modal>
    </PageWrapper>
  )
}
