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

const container = { hidden: {}, show: { transition: { staggerChildren: 0.03 } } }
const item = { hidden: { opacity: 0 }, show: { opacity: 1, transition: { duration: 0.15 } } }

export function DataTable<T>({ columns, data, onRowClick, keyExtractor }: Props<T>) {
  return (
    <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-[0_1px_4px_rgba(0,0,0,0.04)]">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50/60">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    'whitespace-nowrap px-5 py-3 text-[11.5px] font-semibold uppercase tracking-wider text-gray-400',
                    col.align === 'right'
                      ? 'text-right'
                      : col.align === 'center'
                        ? 'text-center'
                        : 'text-left',
                  )}
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
                className={cn('table-row-base', onRowClick && 'cursor-pointer')}
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={cn(
                      'px-5 py-3.5 text-[13.5px]',
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
        <div className="py-14 text-center text-[13.5px] text-gray-400">Inga poster att visa</div>
      )}
    </div>
  )
}
