// Konsoliderad (PR5): den delade, tillgängliga Modal:en bor nu i @eken/ui/react.
// Denna fil är en re-export så alla befintliga anropssajter (@/components/ui/Modal)
// är oförändrade. Admin får nu WCAG-fixarna (bl.a. Escape som saknades) + focus-trap.
export { Modal, ModalFooter, type ModalProps } from '@eken/ui/react'
