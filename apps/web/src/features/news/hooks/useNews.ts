import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  fetchNewsPosts,
  createNewsPost,
  updateNewsPost,
  publishNewsPost,
  deleteNewsPost,
} from '../api/news.api'
import type { CreateNewsPostDto, UpdateNewsPostDto } from '../api/news.api'

export function useNewsPosts() {
  return useQuery({
    queryKey: ['news'],
    queryFn: fetchNewsPosts,
    staleTime: 60_000,
  })
}

export function useCreateNewsPost() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (dto: CreateNewsPostDto) => createNewsPost(dto),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['news'] })
    },
  })
}

export function useUpdateNewsPost() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, dto }: { id: string; dto: UpdateNewsPostDto }) => updateNewsPost(id, dto),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['news'] })
    },
  })
}

export function usePublishNewsPost() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => publishNewsPost(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['news'] })
    },
  })
}

export function useDeleteNewsPost() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteNewsPost(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['news'] })
    },
  })
}
