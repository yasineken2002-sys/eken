import type { CreateNewsPostInput, UpdateNewsPostInput } from '@eken/shared'
import { get, post, patch, del } from '@/lib/api'

export interface NewsPost {
  id: string
  title: string
  content: string
  publishedAt: string | null
  createdAt: string
  targetAll: boolean
  propertyId: string | null
  property?: { name: string } | null
  createdBy: { firstName: string; lastName: string }
}

export function fetchNewsPosts(): Promise<NewsPost[]> {
  return get<NewsPost[]>('/news')
}

export function fetchNewsPost(id: string): Promise<NewsPost> {
  return get<NewsPost>(`/news/${id}`)
}

export function createNewsPost(dto: CreateNewsPostInput): Promise<NewsPost> {
  return post<NewsPost>('/news', dto)
}

export function updateNewsPost(id: string, dto: UpdateNewsPostInput): Promise<NewsPost> {
  return patch<NewsPost>(`/news/${id}`, dto)
}

export function publishNewsPost(id: string): Promise<NewsPost> {
  return post<NewsPost>(`/news/${id}/publish`)
}

export function deleteNewsPost(id: string): Promise<void> {
  return del(`/news/${id}`)
}
