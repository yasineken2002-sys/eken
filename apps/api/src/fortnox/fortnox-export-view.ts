/**
 * TESTKUND-016 K1.6: exportradens vy. Utkastet lämnar aldrig servern; bara de textfält där
 * exporttexten skiljer sig från Eveno-texten (originaltext, exporttext, fält och rad) visas,
 * så att UI kan säga «Exporteras som …».
 */
export interface ExportTextView {
  falt: string
  rad: number | null
  originaltext: string
  exporttext: string
}

export function exportView<T extends { draft?: unknown }>(
  row: T,
): Omit<T, 'draft'> & { exportText: ExportTextView[] } {
  const { draft, ...rest } = row
  const falt = (draft as { provenance?: { text?: { falt?: unknown } } } | null | undefined)
    ?.provenance?.text?.falt
  const exportText = Array.isArray(falt)
    ? falt
        .filter(
          (f): f is { falt: string; rad: number | null; ra: string; export: string } =>
            !!f &&
            typeof f === 'object' &&
            typeof (f as { ra?: unknown }).ra === 'string' &&
            typeof (f as { export?: unknown }).export === 'string',
        )
        .map((f) => ({
          falt: String(f.falt),
          rad: typeof f.rad === 'number' ? f.rad : null,
          originaltext: f.ra,
          exporttext: f.export,
        }))
    : []
  return { ...rest, exportText }
}
