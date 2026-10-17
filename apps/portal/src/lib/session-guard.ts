import { useCallback, useState } from 'react'
import { useMutation, type UseMutationOptions, type MutateOptions } from '@tanstack/react-query'
import { isSessionCurrent, useSessionStore } from '@/store/session.store'
import { isPortalOffline, PortalNetworkError } from './network-state'

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

type MutationAttempt<TVariables> = {
  variables: TVariables
  offlineAtStart: boolean
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
  const { onMutate, ...mutationOptions } = options
  const assertAttempt = (attempt: MutationAttempt<TVariables>) => {
    if (!current()) throw new SessionChangedError()
    if (attempt.offlineAtStart || isPortalOffline()) throw new PortalNetworkError('offline')
  }
  const mutation = useMutation<TData, TError, MutationAttempt<TVariables>, TContext>({
    ...mutationOptions,
    // Portalåtgärder ska avslutas med ett fel, aldrig vänta i en nätkö eller
    // återförsökas utan ett nytt klick. Anroparens options får inte ändra policyn.
    networkMode: 'always',
    retry: false,
    mutationFn: async (attempt, context) => {
      assertAttempt(attempt)
      if (!options.mutationFn) throw new Error('Mutation saknar funktion')
      try {
        const result = await options.mutationFn(attempt.variables, context)
        if (!current()) throw new SessionChangedError()
        return result
      } catch (error) {
        if (!current()) throw new SessionChangedError()
        throw error
      }
    },
    ...(onMutate
      ? {
          onMutate: (
            attempt: MutationAttempt<TVariables>,
            context: Parameters<typeof onMutate>[1],
          ) => {
            assertAttempt(attempt)
            return onMutate(attempt.variables, context)
          },
        }
      : {}),
    onSuccess: (data, attempt, result, context) => {
      return current() ? options.onSuccess?.(data, attempt.variables, result, context) : undefined
    },
    onError: (error, attempt, result, context) => {
      return current() ? options.onError?.(error, attempt.variables, result, context) : undefined
    },
    onSettled: (data, error, attempt, result, context) => {
      return current()
        ? options.onSettled?.(data, error, attempt.variables, result, context)
        : undefined
    },
  })
  const callbacks = (
    value?: MutateOptions<TData, TError, TVariables, TContext>,
  ): MutateOptions<TData, TError, MutationAttempt<TVariables>, TContext> => ({
    onSuccess: (data, attempt, result, context) => {
      if (current()) return value?.onSuccess?.(data, attempt.variables, result, context)
    },
    onError: (error, attempt, result, context) => {
      if (current()) return value?.onError?.(error, attempt.variables, result, context)
    },
    onSettled: (data, error, attempt, result, context) => {
      if (current()) return value?.onSettled?.(data, error, attempt.variables, result, context)
    },
  })
  return {
    ...mutation,
    variables: mutation.variables?.variables,
    mutate: (variables: TVariables, value?: MutateOptions<TData, TError, TVariables, TContext>) => {
      // Fånga nätläget vid själva klicket: Query kan await:a före mutationFn.
      if (current()) {
        mutation.mutate({ variables, offlineAtStart: isPortalOffline() }, callbacks(value))
      }
    },
    mutateAsync: (
      variables: TVariables,
      value?: MutateOptions<TData, TError, TVariables, TContext>,
    ) => {
      if (!current()) return Promise.reject(new SessionChangedError())
      return mutation.mutateAsync(
        { variables, offlineAtStart: isPortalOffline() },
        callbacks(value),
      )
    },
  }
}
