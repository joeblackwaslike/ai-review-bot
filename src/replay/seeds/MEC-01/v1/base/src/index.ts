import { request } from './client'
import { withRetry } from './retry'
import { TtlCache } from './cache'

const cache = new TtlCache<unknown>(60000)

export async function getResource(id: string) {
  const cached = cache.get(id)
  if (cached !== undefined) return cached
  const value = await withRetry(() => request(`/resources/${id}`))
  cache.set(id, value)
  return value
}
