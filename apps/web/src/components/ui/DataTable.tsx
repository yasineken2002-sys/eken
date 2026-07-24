// Konsoliderad (PR6): den delade DataTable:n bor nu i @eken/ui/react.
// Denna fil är en re-export så alla befintliga anropssajter
// (@/components/ui/DataTable) är oförändrade. Tangentbords-a11y:n på klickbara
// rader (tabIndex/Enter/Blanksteg/focus-ring) kommer nu från paketet, och
// radens hover/avdelare läses ur --ev-row-hover / --ev-row-border.
export { DataTable, type DataTableProps, type DataTableColumn } from '@eken/ui/react'
