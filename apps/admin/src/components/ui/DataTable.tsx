// PR6: admins handrullade <table>-block ersätts av den delade DataTable:n i
// @eken/ui/react (samma källa som web). Re-export så anropssajterna importerar
// från '@/components/ui/DataTable' precis som övriga UI-komponenter.
export { DataTable, type DataTableProps, type DataTableColumn } from '@eken/ui/react'
