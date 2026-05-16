'use client'

import { Suspense, useMemo } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { Starfield } from './Starfield'
import { Building } from './Building'
import { Effects } from './Effects'
import { prefersReducedMotion } from '@/lib/motion'

/** Scales the building down on small viewports so it stays framed. */
function ResponsiveBuilding({ animate }: { animate: boolean }) {
  const width = useThree((s) => s.size.width)
  const scale = width < 768 ? 0.62 : width < 1100 ? 0.82 : 1
  return (
    <group scale={scale}>
      <Building animate={animate} />
    </group>
  )
}

/**
 * The WebGL stage. Mounted client-only (dynamic ssr:false) so Three
 * never touches the server. Camera is static this phase — GSAP takes
 * the wheel in Phase 3.
 */
export function Scene() {
  const animate = useMemo(() => !prefersReducedMotion(), [])

  return (
    <Canvas
      camera={{ position: [0, 0, 50], fov: 75, near: 0.1, far: 200 }}
      dpr={[1, 1.8]}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      frameloop="always"
    >
      <color attach="background" args={['#0A0E1F']} />

      {/* Cool ambient void light — rgb(20,30,70) */}
      <ambientLight color={[20 / 255, 30 / 255, 70 / 255]} intensity={0.3} />
      {/* Key light, top-front-right */}
      <directionalLight color="#ffffff" intensity={0.6} position={[6, 9, 7]} />
      {/* Electric-blue underglow beneath the building */}
      <pointLight color="#5B7FE0" intensity={1.6} position={[0, -9, 4]} decay={0} />

      <Suspense fallback={null}>
        <Starfield animate={animate} />
        <ResponsiveBuilding animate={animate} />
        <Effects />
      </Suspense>
    </Canvas>
  )
}
