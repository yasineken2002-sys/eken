// @eken/ui/react — delade React-komponenter (Tailwind/framer). Konsumeras av
// web + admin. Ligger MEDVETET utanför paketets huvud-entry (@eken/ui) så att
// branding-kedjan @eken/shared → @eken/ui aldrig drar in React i API:t.
export { Modal, ModalFooter, type ModalProps } from './Modal'
export { useFocusTrap } from './useFocusTrap'
