import { motion } from 'framer-motion'
import { cn } from '@/lib/cn'

interface Column<T> {
  key: string
  header: string
  cell: (row: T) => React.ReactNode
  width?: string
  align?: 'left' | 'right' | 'center'
}

interface Props<T> {
  columns: Column<T>[]
  data: T[]
  onRowClick?: (row: T) => void
  keyExtractor: (row: T) => string
}

const container = { hidden: {}, show: { transition: { staggerChildren: 0.035 } } }
const item = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { duration: 0.18 } } }

export function DataTable<T>({ columns, data, onRowClick, keyExtractor }: Props<T>) {
  return (
    <div className="overflow-hidden rounded border bg-white" style={{ borderColor: '#E3E7EC' }}>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr style={{ borderBottom: '1px solid #E3E7EC', background: '#F8FAFB' }}>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    'whitespace-nowrap px-4 py-2.5 text-[11.5px] font-semibold uppercase tracking-wide',
                    col.align === 'right'
                      ? 'text-right'
                      : col.align === 'center'
                        ? 'text-center'
                        : 'text-left',
                  )}
                  style={{ color: '#8A95A3' }}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <motion.tbody variants={container} initial="hidden" animate="show">
            {data.map((row) => (
              <motion.tr
                key={keyExtractor(row)}
                variants={item}
                onClick={() => onRowClick?.(row)}
                className={cn('fn-row', onRowClick && 'cursor-pointer')}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={cn(
                      'px-4 py-3 text-[13px]',
                      col.align === 'right'
                        ? 'text-right'
                        : col.align === 'center'
                          ? 'text-center'
                          : '',
                    )}
                  >
                    {col.cell(row)}
                  </td>
                ))}
              </motion.tr>
            ))}
          </motion.tbody>
        </table>
      </div>
      {data.length === 0 && (
        <div className="py-12 text-center text-[13px]" style={{ color: '#8A95A3' }}>
          Inga poster att visa
        </div>
      )}
    </div>
  )
}
