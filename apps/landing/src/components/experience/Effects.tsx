import { EffectComposer, Bloom } from '@react-three/postprocessing'

/**
 * Only the lit windows cross the 0.6 luminance threshold, so the bloom
 * reads as warm light spilling out of the building rather than a wash
 * over the whole scene. mipmapBlur keeps it cheap (single extra pass).
 */
export function Effects() {
  return (
    <EffectComposer>
      <Bloom
        mipmapBlur
        luminanceThreshold={0.6}
        luminanceSmoothing={0.2}
        intensity={0.8}
        radius={0.5}
      />
    </EffectComposer>
  )
}
