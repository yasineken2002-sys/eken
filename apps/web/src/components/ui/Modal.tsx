// Konsoliderad (PR5): den delade, tillgängliga Modal:en bor nu i @eken/ui/react.
// Denna fil är en re-export så alla befintliga anropssajter (@/components/ui/Modal)
// är oförändrade. WCAG-fixarna (role/aria-modal/aria-labelledby/focus-trap/Escape/
// aria-label) och det enade utseendet kommer nu från paketet.
export { Modal, ModalFooter, type ModalProps } from '@eken/ui/react'
