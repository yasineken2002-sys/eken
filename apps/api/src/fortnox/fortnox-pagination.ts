/**
 * Fortnox tomma samling (observerad 2026-10-02 mot testföretag, GET financialyears/
 * costcenters/projects): HTTP 200, `@CurrentPage=1`, `@TotalPages=0`,
 * `@TotalResources=0` och en tom lista. Det är den ENDA formen där TotalPages får
 * vara 0. Allt annat (fel sida, motsägande antal, saknad lista, fel typer, element i
 * listan) behandlas som vanligt av respektive sidläsare och avvisas där.
 */
export function isExactEmptyFirstPage(
  page: number,
  body: Record<string, unknown> | null | undefined,
  key: string,
): boolean {
  if (page !== 1 || !body || typeof body !== 'object') return false
  const mi = body.MetaInformation as Record<string, unknown> | undefined
  if (!mi || typeof mi !== 'object') return false
  const list = body[key]
  return (
    mi['@CurrentPage'] === 1 &&
    mi['@TotalPages'] === 0 &&
    mi['@TotalResources'] === 0 &&
    Array.isArray(list) &&
    list.length === 0
  )
}
