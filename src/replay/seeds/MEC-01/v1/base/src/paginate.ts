export interface Page<T> { items: T[], next?: string }

export async function* paginate<T>(fetchPage: (cursor?: string) => Promise<Page<T>>) {
  let cursor: string | undefined
  do {
    const page = await fetchPage(cursor)
    for (const item of page.items) yield item
    cursor = page.next
  } while (cursor)
}
