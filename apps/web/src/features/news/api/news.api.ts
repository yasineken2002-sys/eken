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

export interface CreateNewsPostDto {
  title: string
  content: string
  targetAll: boolean
  propertyId?: string | null
}

export interface UpdateNewsPostDto {
  title?: string
  content?: string
  targetAll?: boolean
  propertyId?: string | null
}

export function fetchNewsPosts(): Promise<NewsPost[]> {
  return get<NewsPost[]>('/news')
}

export function fetchNewsPost(id: string): Promise<NewsPost> {
  return get<NewsPost>(`/news/${id}`)
}

export function createNewsPost(dto: CreateNewsPostDto): Promise<NewsPost> {
  return post<NewsPost>('/news', dto)
}

export function updateNewsPost(id: string, dto: UpdateNewsPostDto): Promise<NewsPost> {
  return patch<NewsPost>(`/news/${id}`, dto)
}

export function publishNewsPost(id: string): Promise<NewsPost> {
  return post<NewsPost>(`/news/${id}/publish`, {})
}

export function deleteNewsPost(id: string): Promise<void> {
  return del(`/news/${id}`)
}
