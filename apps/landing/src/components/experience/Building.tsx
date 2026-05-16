import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

// ── Building dimensions (Three.js units) ──────────────────────────────
const W = 8 // width  (x)
const H = 12 // height (y)
const D = 6 // depth  (z)
const FLOORS = 5
const COLS = 4 // windows per floor per side
const FLOOR_H = H / FLOORS // 2.4

// Floor centres, shared by every side.
const ROW_Y = Array.from({ length: FLOORS }, (_, i) => -H / 2 + FLOOR_H * i + FLOOR_H / 2) // [-4.8, -2.4, 0, 2.4, 4.8]

const COL_X = [-3, -1, 1, 3] // columns across the width (front/back)
const COL_Z = [-2, -0.7, 0.7, 2] // columns across the depth (left/right)

const WIN_COUNT = FLOORS * COLS * 4 // 80 windows — all four sides
const LIT_INTENSITY = 1.5
const LIT_PROB = 0.35 // ~35% lit at any moment

type Placement = {
  x: number
  y: number
  z: number
  rotY: number
  nx: number // outward normal
  nz: number
}

type WindowState = { lit: boolean; value: number; next: number }

/**
 * A 5-floor Scandinavian apartment block, windows on ALL four faces
 * (5 floors × 4 columns × 4 sides = 80 independently-lit windows).
 *
 * Performance: all 80 window panes are ONE InstancedMesh (1 draw call)
 * and all 80 frames another. Per-window glow is a single instanced
 * float attribute (`aGlow`) injected into MeshStandardMaterial via
 * onBeforeCompile, so the lit/unlit choreography is just 80 float
 * lerps + one buffer upload per frame — no extra draw calls, no React
 * re-renders. Total ≈ 8 draw calls / ~2k tris for the whole building.
 */
function BuildingImpl({ animate = true }: { animate?: boolean }) {
  const groupRef = useRef<THREE.Group>(null)
  const paneRef = useRef<THREE.InstancedMesh>(null)
  const frameRef = useRef<THREE.InstancedMesh>(null)

  // Window placements, ordered front → back → right → left.
  const placements = useMemo<Placement[]>(() => {
    const list: Placement[] = []
    for (const r of ROW_Y)
      for (const x of COL_X) list.push({ x, y: r, z: D / 2, rotY: 0, nx: 0, nz: 1 }) // front
    for (const r of ROW_Y)
      for (const x of COL_X) list.push({ x, y: r, z: -D / 2, rotY: Math.PI, nx: 0, nz: -1 }) // back
    for (const r of ROW_Y)
      for (const z of COL_Z) list.push({ x: W / 2, y: r, z, rotY: Math.PI / 2, nx: 1, nz: 0 }) // right
    for (const r of ROW_Y)
      for (const z of COL_Z) list.push({ x: -W / 2, y: r, z, rotY: -Math.PI / 2, nx: -1, nz: 0 }) // left
    return list
  }, [])

  // Per-instance glow buffer (0 → 1.5), uploaded to the GPU each frame.
  const glow = useMemo(() => new Float32Array(WIN_COUNT), [])

  const paneGeo = useMemo(() => {
    const g = new THREE.BoxGeometry(1.05, 1.5, 0.1)
    g.setAttribute('aGlow', new THREE.InstancedBufferAttribute(glow, 1))
    return g
  }, [glow])
  const frameGeo = useMemo(() => new THREE.BoxGeometry(1.35, 1.85, 0.04), [])

  const paneMat = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({
      color: '#1F2940',
      metalness: 0.2,
      roughness: 0.35,
    })
    m.emissive = new THREE.Color('#5B7FE0')
    m.emissiveIntensity = 1
    // Scale the emissive term by the per-instance glow attribute.
    m.onBeforeCompile = (shader) => {
      shader.vertexShader =
        'attribute float aGlow;\nvarying float vGlow;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n  vGlow = aGlow;',
        )
      shader.fragmentShader =
        'varying float vGlow;\n' +
        shader.fragmentShader.replace(
          'vec3 totalEmissiveRadiance = emissive;',
          'vec3 totalEmissiveRadiance = emissive * vGlow;',
        )
    }
    m.customProgramCacheKey = () => 'eveno-window-glow'
    return m
  }, [])

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

  const windowState = useRef<WindowState[]>([])

  // One-time: place all 80 instances + seed the lighting state.
  useEffect(() => {
    const dummy = new THREE.Object3D()
    const setMatrices = (mesh: THREE.InstancedMesh | null, offset: number) => {
      if (!mesh) return
      placements.forEach((p, i) => {
        dummy.position.set(p.x + p.nx * offset, p.y, p.z + p.nz * offset)
        dummy.rotation.set(0, p.rotY, 0)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
      })
      mesh.instanceMatrix.needsUpdate = true
    }
    setMatrices(paneRef.current, 0.05)
    setMatrices(frameRef.current, 0.012)

    const t0 = 0
    windowState.current = placements.map((_, i) => {
      const lit = Math.random() < LIT_PROB
      glow[i] = lit ? LIT_INTENSITY : 0
      return {
        lit,
        value: glow[i],
        next: t0 + 1 + Math.random() * 5,
      }
    })
    if (paneRef.current) {
      paneRef.current.geometry.attributes.aGlow.needsUpdate = true
    }
  }, [placements, glow])

  useFrame((state, delta) => {
    if (!animate) return

    const group = groupRef.current
    if (group) group.rotation.y += delta * ((Math.PI * 2) / 60)

    const t = state.clock.elapsedTime
    // Frame-rate-independent smoothing → ~1.5s perceptual settle.
    const k = 1 - Math.exp(-delta / 0.55)
    const win = windowState.current
    for (let i = 0; i < win.length; i++) {
      const w = win[i]
      if (t > w.next) {
        w.lit = Math.random() < LIT_PROB
        w.next = t + 2.5 + Math.random() * 4.5
      }
      const target = w.lit ? LIT_INTENSITY : 0
      w.value += (target - w.value) * k
      glow[i] = w.value
    }
    const attr = paneRef.current?.geometry.attributes.aGlow
    if (attr) attr.needsUpdate = true
  })

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

      {/* 80 window frames — 1 draw call */}
      <instancedMesh ref={frameRef} args={[frameGeo, frameMat, WIN_COUNT]} frustumCulled={false} />
      {/* 80 glowing panes — 1 draw call */}
      <instancedMesh ref={paneRef} args={[paneGeo, paneMat, WIN_COUNT]} frustumCulled={false} />
    </group>
  )
}

export const Building = BuildingImpl
