import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

// ── Building dimensions (Three.js units) ──────────────────────────────
const W = 8 // width
const H = 12 // height
const D = 6 // depth
const FLOORS = 5
const COLS = 4 // windows per floor → 20 windows total
const FLOOR_H = H / FLOORS // 2.4

const COL_X = [-3, -1, 1, 3] // window column centres
const ROW_Y = Array.from({ length: FLOORS }, (_, i) => -H / 2 + FLOOR_H * i + FLOOR_H / 2) // [-4.8, -2.4, 0, 2.4, 4.8]

const LIT_INTENSITY = 1.5
const LIT_PROBABILITY = 0.35 // ~35% of windows lit at any moment
const FRONT_Z = D / 2 // 3

type WindowState = {
  mat: THREE.MeshStandardMaterial
  lit: boolean
  value: number // current emissiveIntensity (lerped)
  next: number // clock time of next lit/unlit decision
}

/**
 * A 5-floor Scandinavian apartment block built from Three primitives.
 * ~560 triangles total — well under the 5k budget.
 *
 * Every window is its own mesh with its own material so each can be
 * lit independently. The lit/unlit choreography runs in ONE useFrame
 * over a plain array (no React state, no per-window subscribers) so
 * 20 windows cost one loop per frame.
 */
function BuildingImpl({ animate = true }: { animate?: boolean }) {
  const groupRef = useRef<THREE.Group>(null)

  // Stable materials — one per window, mutated in-place each frame.
  const windowMats = useMemo(
    () =>
      Array.from({ length: FLOORS * COLS }, () => {
        const lit = Math.random() < LIT_PROBABILITY
        return new THREE.MeshStandardMaterial({
          color: '#1F2940',
          emissive: '#5B7FE0',
          emissiveIntensity: lit ? LIT_INTENSITY : 0,
          metalness: 0.2,
          roughness: 0.35,
        })
      }),
    [],
  )

  const bodyMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#0F1F47',
        metalness: 0.45,
        roughness: 0.55,
      }),
    [],
  )
  const frameMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#0A1226', roughness: 0.7 }),
    [],
  )
  const trimMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#0B1A3C', roughness: 0.6 }),
    [],
  )

  // Per-window choreography state, seeded from the materials' initial lit.
  const windowState = useRef<WindowState[]>(
    windowMats.map((mat) => {
      const lit = mat.emissiveIntensity > 0
      return {
        mat,
        lit,
        value: lit ? LIT_INTENSITY : 0,
        next: 1 + Math.random() * 5,
      }
    }),
  )

  useFrame((state, delta) => {
    if (!animate) return
    const group = groupRef.current
    if (group) {
      // One full revolution every 60s.
      group.rotation.y += delta * ((Math.PI * 2) / 60)
    }

    const t = state.clock.elapsedTime
    // Exponential smoothing → ~1.5s perceptual settle, frame-rate independent.
    const k = 1 - Math.exp(-delta / 0.55)
    const win = windowState.current
    for (let i = 0; i < win.length; i++) {
      const w = win[i]
      if (t > w.next) {
        w.lit = Math.random() < LIT_PROBABILITY
        w.next = t + 2.5 + Math.random() * 4.5
      }
      const target = w.lit ? LIT_INTENSITY : 0
      w.value += (target - w.value) * k
      w.mat.emissiveIntensity = w.value
    }
  })

  const windows = useMemo(() => {
    const items: { key: string; pos: [number, number, number]; idx: number }[] = []
    let idx = 0
    for (let r = 0; r < FLOORS; r++) {
      for (let c = 0; c < COLS; c++) {
        items.push({
          key: `w-${r}-${c}`,
          pos: [COL_X[c], ROW_Y[r], 0],
          idx: idx++,
        })
      }
    }
    return items
  }, [])

  // Internal floor boundaries → thin horizontal trim bands.
  const separators = useMemo(
    () => Array.from({ length: FLOORS - 1 }, (_, k) => -H / 2 + FLOOR_H * (k + 1)),
    [],
  )

  return (
    <group ref={groupRef} rotation={[0, -0.32, 0]}>
      {/* Main body */}
      <mesh material={bodyMat}>
        <boxGeometry args={[W, H, D]} />
      </mesh>

      {/* Flat roof with a slight overhang */}
      <mesh position={[0, H / 2 + 0.2, 0]} material={trimMat}>
        <boxGeometry args={[W + 0.5, 0.4, D + 0.5]} />
      </mesh>

      {/* Horizontal floor lines (wrap all faces) */}
      {separators.map((y) => (
        <mesh key={`sep-${y}`} position={[0, y, 0]} material={trimMat}>
          <boxGeometry args={[W + 0.06, 0.13, D + 0.06]} />
        </mesh>
      ))}

      {/* Windows + frames on the front facade */}
      {windows.map(({ key, pos, idx }) => (
        <group key={key} position={[pos[0], pos[1], 0]}>
          <mesh position={[0, 0, FRONT_Z + 0.015]} material={frameMat}>
            <boxGeometry args={[1.35, 1.85, 0.04]} />
          </mesh>
          <mesh position={[0, 0, FRONT_Z + 0.05]} material={windowMats[idx]}>
            <boxGeometry args={[1.05, 1.5, 0.1]} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

export const Building = BuildingImpl
