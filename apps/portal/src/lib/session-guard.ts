import { useCallback, useState } from 'react'
import { useMutation, type UseMutationOptions, type MutateOptions } from '@tanstack/react-query'
import { isSessionCurrent, useSessionStore } from '@/store/session.store'

/** Bär medvetet inget gammalt svar, konto, token eller Axios-config. */
export class SessionChangedError extends Error {
  constructor() {
    super('Sessionen har ändrats. Svaret används inte.')
    this.name = 'SessionChangedError'
  }
}

export function useSessionGuard(): () => boolean {
  const [generation] = useState(() => useSessionStore.getState().sessionGeneration)
  return useCallback(() => isSessionCurrent(generation), [generation])
}

// React Query kan köra hook-callbacks efter unmount. Cacherensning ensam
// hindrar alltså inte en gammal inloggning från att sätta en ny session.
export function useSessionMutation<
  TData = unknown,
  TError = Error,
  TVariables = void,
  TContext = unknown,
>(options: UseMutationOptions<TData, TError, TVariables, TContext>) {
  const current = useSessionGuard()
  const onMutate = options.onMutate
  const mutation = useMutation<TData, TError, TVariables, TContext>({
    ...options,
    mutationFn: async (...args) => {
      if (!current()) throw new SessionChangedError()
      if (!options.mutationFn) throw new Error('Mutation saknar funktion')
      try {
        const result = await options.mutationFn(...args)
        if (!current()) throw new SessionChangedError()
        return result
      } catch (error) {
        if (!current()) throw new SessionChangedError()
        throw error
      }
    },
    ...(onMutate
      ? {
          onMutate: (...args: Parameters<typeof onMutate>) => {
            if (!current()) throw new SessionChangedError()
            return onMutate(...args)
          },
        }
      : {}),
    onSuccess: (...args) => {
      return current() ? options.onSuccess?.(...args) : undefined
    },
    onError: (...args) => {
      return current() ? options.onError?.(...args) : undefined
    },
    onSettled: (...args) => {
      return current() ? options.onSettled?.(...args) : undefined
    },
  })
  const callbacks = (
    value?: MutateOptions<TData, TError, TVariables, TContext>,
  ): MutateOptions<TData, TError, TVariables, TContext> => ({
    onSuccess: (...args) => {
      if (current()) return value?.onSuccess?.(...args)
    },
    onError: (...args) => {
      if (current()) return value?.onError?.(...args)
    },
    onSettled: (...args) => {
      if (current()) return value?.onSettled?.(...args)
    },
  })
  return {
    ...mutation,
    mutate: (variables: TVariables, value?: MutateOptions<TData, TError, TVariables, TContext>) => {
      if (current()) mutation.mutate(variables, callbacks(value))
    },
    mutateAsync: (
      variables: TVariables,
      value?: MutateOptions<TData, TError, TVariables, TContext>,
    ) => {
      if (!current()) return Promise.reject(new SessionChangedError())
      return mutation.mutateAsync(variables, callbacks(value))
    },
  }
}
