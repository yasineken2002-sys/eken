import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

const STAR_COUNT = 130

const vertexShader = /* glsl */ `
  attribute float aSize;
  attribute float aPhase;
  uniform float uTime;
  varying float vTwinkle;

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // Perspective size attenuation — closer stars read larger.
    gl_PointSize = aSize * (300.0 / -mv.z);
    // ~4s twinkle cycle, phase-shifted per star so it never pulses in unison.
    vTwinkle = 0.3 + 0.7 * (0.5 + 0.5 * sin(uTime * 1.5708 + aPhase));
  }
`

const fragmentShader = /* glsl */ `
  varying float vTwinkle;

  void main() {
    // Soft round dot.
    float d = length(gl_PointCoord - 0.5);
    float alpha = smoothstep(0.5, 0.0, d) * vTwinkle;
    gl_FragColor = vec4(1.0, 1.0, 1.0, alpha);
  }
`

/**
 * 130 white stars rendered in a single draw call (THREE.Points).
 * Each star carries its own size + twinkle phase; the depth spread
 * gives natural parallax once the camera starts moving (Phase 3).
 */
function StarfieldImpl({ animate = true }: { animate?: boolean }) {
  const materialRef = useRef<THREE.ShaderMaterial>(null)

  const { positions, sizes, phases } = useMemo(() => {
    const positions = new Float32Array(STAR_COUNT * 3)
    const sizes = new Float32Array(STAR_COUNT)
    const phases = new Float32Array(STAR_COUNT)

    for (let i = 0; i < STAR_COUNT; i++) {
      positions[i * 3 + 0] = (Math.random() - 0.5) * 130 // x
      positions[i * 3 + 1] = (Math.random() - 0.5) * 85 // y
      positions[i * 3 + 2] = -75 + Math.random() * 95 // z (depth)
      sizes[i] = 0.9 + Math.random() * 1.9
      phases[i] = Math.random() * Math.PI * 2
    }

    return { positions, sizes, phases }
  }, [])

  const uniforms = useMemo(() => ({ uTime: { value: 0 } }), [])

  useFrame((_, delta) => {
    if (!animate || !materialRef.current) return
    materialRef.current.uniforms.uTime.value += delta
  })

  return (
    <points frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-aSize" args={[sizes, 1]} />
        <bufferAttribute attach="attributes-aPhase" args={[phases, 1]} />
      </bufferGeometry>
      <shaderMaterial
        ref={materialRef}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  )
}

export const Starfield = StarfieldImpl
