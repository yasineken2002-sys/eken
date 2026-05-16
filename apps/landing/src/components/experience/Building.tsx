import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'

// ── Building dimensions (Three.js units) ──────────────────────────────
const W = 8 // width  (x)
const H = 12 // height (y)
const D = 6 // depth  (z)
const FLOORS = 5
const FLOOR_H = H / FLOORS // 2.4
const TOP = H / 2 // 6   — roofline
const BASE = -H / 2 // -6  — ground contact

// Floor centres, shared by every side. Index 0 == ground floor.
const ROW_Y = Array.from({ length: FLOORS }, (_, i) => BASE + FLOOR_H * i + FLOOR_H / 2) // [-4.8 … 4.8]

const COL_X = [-3, -1, 1, 3] // columns across the width (front/back)
const COL_Z = [-2, -0.7, 0.7, 2] // columns across the depth (left/right)

const FRONT_Z = D / 2 // +3 — the face that carries the entrance

const LIT_INTENSITY = 1.5
const LIT_PROB = 0.35 // ~35% lit at any moment
const BALCONY_RATE = 24 // ≈% of non-ground windows that get a balcony

type Placement = {
  x: number
  y: number
  z: number
  rotY: number
  nx: number // outward normal
  nz: number
  floor: number
}

type WindowState = { lit: boolean; value: number; next: number }

// Stable per-window pseudo-random — keeps the balcony layout identical
// across reloads (real buildings don't rearrange their balconies).
const hash = (i: number, f: number) => (((i * 73856093) ^ (f * 19349663)) >>> 0) % 100

/**
 * A 5-floor Scandinavian "hyreshus" — a recognisable apartment building,
 * not a box. Body + parapet roof + chimney + foundation plinth, windows
 * with pronounced light frames on all four faces, a recessed front
 * entrance with canopy / warm light / nameplate / flanking lamp posts,
 * and selective balconies. It sits on a static ground plane (a turntable
 * floor) while the whole "lot" rotates so every angle stays intentional.
 *
 * Performance: every window pane is ONE InstancedMesh (1 draw call) and
 * every frame another; balcony slabs + rails are one InstancedMesh each.
 * Per-window glow is a single instanced float attribute (`aGlow`)
 * injected into MeshStandardMaterial via onBeforeCompile, so the lit
 * choreography is just N float lerps + one buffer upload per frame — no
 * extra draw calls, no React re-renders. Lamps/door glow are emissive +
 * bloom (no per-light cost); a single warm point light gives the porch
 * its depth. Total well under 3k tris / ~30 draw calls → solid 60fps.
 */
function BuildingImpl({ animate = true }: { animate?: boolean }) {
  const groupRef = useRef<THREE.Group>(null)
  const paneRef = useRef<THREE.InstancedMesh>(null)
  const frameRef = useRef<THREE.InstancedMesh>(null)
  const slabRef = useRef<THREE.InstancedMesh>(null)
  const railRef = useRef<THREE.InstancedMesh>(null)

  // Window placements, ordered front → back → right → left. The two
  // ground-floor centre slots on the front are omitted — that is where
  // the entrance goes.
  const placements = useMemo<Placement[]>(() => {
    const list: Placement[] = []
    ROW_Y.forEach((y, f) => {
      for (const x of COL_X) {
        if (f === 0 && (x === -1 || x === 1)) continue // entrance gap
        list.push({ x, y, z: FRONT_Z, rotY: 0, nx: 0, nz: 1, floor: f })
      }
    })
    ROW_Y.forEach((y, f) => {
      for (const x of COL_X) list.push({ x, y, z: -D / 2, rotY: Math.PI, nx: 0, nz: -1, floor: f })
    })
    ROW_Y.forEach((y, f) => {
      for (const z of COL_Z)
        list.push({ x: W / 2, y, z, rotY: Math.PI / 2, nx: 1, nz: 0, floor: f })
    })
    ROW_Y.forEach((y, f) => {
      for (const z of COL_Z)
        list.push({ x: -W / 2, y, z, rotY: -Math.PI / 2, nx: -1, nz: 0, floor: f })
    })
    return list
  }, [])

  const WIN_COUNT = placements.length

  // Selective balconies — never on the ground floor, deterministic ~20%.
  const balconies = useMemo(
    () => placements.filter((p, i) => p.floor >= 1 && hash(i, p.floor) < BALCONY_RATE),
    [placements],
  )

  // Per-instance glow buffer (0 → 1.5), uploaded to the GPU each frame.
  const glow = useMemo(() => new Float32Array(WIN_COUNT), [WIN_COUNT])

  const paneGeo = useMemo(() => {
    const g = new THREE.BoxGeometry(1.05, 1.5, 0.1)
    g.setAttribute('aGlow', new THREE.InstancedBufferAttribute(glow, 1))
    return g
  }, [glow])
  const frameGeo = useMemo(() => new THREE.BoxGeometry(1.42, 1.92, 0.14), [])
  const slabGeo = useMemo(() => new THREE.BoxGeometry(1.5, 0.12, 0.78), [])
  const railGeo = useMemo(() => new THREE.BoxGeometry(1.5, 0.56, 0.05), [])

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
    () => new THREE.MeshStandardMaterial({ color: '#0F1F47', metalness: 0.45, roughness: 0.55 }),
    [],
  )
  // Window frames: clearly LIGHTER than the body and proud of the
  // facade so glass reads as recessed — instant "real window".
  const frameMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#9AAAD0', roughness: 0.55 }),
    [],
  )
  const trimMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#0B1A3C', roughness: 0.6 }),
    [],
  )
  // Roof edge / canopy / coping — a touch lighter than the body so the
  // architecture catches the key light.
  const roofMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#16264F', roughness: 0.6 }),
    [],
  )
  // Deep shadow material — recessed doorway, inset roof deck.
  const deckMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#070C18', roughness: 0.85 }),
    [],
  )
  const darkMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#0A1226', roughness: 0.7 }),
    [],
  )
  const balconyMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#1C2D58', roughness: 0.6 }),
    [],
  )
  // Light Scandinavian balustrade — must read against the navy facade.
  const railMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#8C9CC4', metalness: 0.2, roughness: 0.5 }),
    [],
  )
  const doorMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#0E1A3A', metalness: 0.2, roughness: 0.6 }),
    [],
  )
  const groundMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#0E1530', roughness: 0.95, metalness: 0 }),
    [],
  )
  const apronMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#141C38', roughness: 0.9 }),
    [],
  )
  // Mint glow — emissive, picked up by the bloom pass.
  const lampMat = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({ color: '#ADE0C5', roughness: 0.4 })
    m.emissive = new THREE.Color('#ADE0C5')
    m.emissiveIntensity = 1.1
    return m
  }, [])
  const porchMat = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({ color: '#ADE0C5', roughness: 0.5 })
    m.emissive = new THREE.Color('#ADE0C5')
    m.emissiveIntensity = 0.6 // ≈ "Mint Glow at 50%"
    return m
  }, [])
  const plateMat = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({ color: '#ADE0C5', roughness: 0.5 })
    m.emissive = new THREE.Color('#ADE0C5')
    m.emissiveIntensity = 0.35 // faintly lit sign
    return m
  }, [])
  const poolMat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: '#ADE0C5', transparent: true, opacity: 0.16 }),
    [],
  )

  const windowState = useRef<WindowState[]>([])

  // One-time: place all instanced meshes + seed the lighting state.
  useEffect(() => {
    const dummy = new THREE.Object3D()

    const setInstances = (
      mesh: THREE.InstancedMesh | null,
      items: Placement[],
      out: number,
      dy: number,
    ) => {
      if (!mesh) return
      items.forEach((p, i) => {
        dummy.position.set(p.x + p.nx * out, p.y + dy, p.z + p.nz * out)
        dummy.rotation.set(0, p.rotY, 0)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
      })
      mesh.instanceMatrix.needsUpdate = true
    }

    setInstances(paneRef.current, placements, 0.05, 0)
    setInstances(frameRef.current, placements, 0.045, 0)
    // Balcony slab sits below the window sill and protrudes from the
    // facade; the rail stands at the slab's outer lip.
    setInstances(slabRef.current, balconies, 0.42, -0.92)
    setInstances(railRef.current, balconies, 0.78, -0.64)

    windowState.current = placements.map((_, i) => {
      const lit = Math.random() < LIT_PROB
      glow[i] = lit ? LIT_INTENSITY : 0
      return { lit, value: glow[i], next: 1 + Math.random() * 5 }
    })
    if (paneRef.current) paneRef.current.geometry.attributes.aGlow.needsUpdate = true
  }, [placements, balconies, glow])

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
    () => Array.from({ length: FLOORS - 1 }, (_, k) => BASE + FLOOR_H * (k + 1)),
    [],
  )

  return (
    <group>
      {/* ── Static ground (the turntable / city floor) ──────────────── */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, BASE - 0.02, 0]} material={groundMat}>
        <planeGeometry args={[64, 64]} />
      </mesh>
      {/* Faint city grid — barely-there, intentional from every angle */}
      <gridHelper args={[64, 32, '#1A2547', '#121A33']} position={[0, BASE + 0.005, 0]} />

      {/* ── The rotating "lot" — building + entrance furniture ───────── */}
      <group ref={groupRef} rotation={[0, -0.32, 0]}>
        {/* Foundation plinth — grounds the building like a sockel */}
        <mesh position={[0, BASE + 0.4, 0]} material={darkMat}>
          <boxGeometry args={[W + 0.3, 0.8, D + 0.3]} />
        </mesh>

        {/* Main body */}
        <mesh material={bodyMat}>
          <boxGeometry args={[W, H, D]} />
        </mesh>

        {/* Horizontal floor lines (wrap all faces) */}
        {separators.map((y) => (
          <mesh key={`sep-${y}`} position={[0, y, 0]} material={trimMat}>
            <boxGeometry args={[W + 0.06, 0.13, D + 0.06]} />
          </mesh>
        ))}

        {/* Flat roof with a deliberate parapet edge + inset deck */}
        <mesh position={[0, TOP + 0.4, 0]} material={roofMat}>
          <boxGeometry args={[W + 0.35, 0.8, D + 0.35]} />
        </mesh>
        <mesh position={[0, TOP + 0.25, 0]} material={deckMat}>
          <boxGeometry args={[W - 0.5, 0.6, D - 0.5]} />
        </mesh>

        {/* Chimney — off-centre, taller than wide, same navy as body */}
        <mesh position={[-2.4, TOP + 0.8 + 1.0, -1]} material={bodyMat}>
          <boxGeometry args={[1.0, 2.0, 0.95]} />
        </mesh>
        <mesh position={[-2.4, TOP + 0.8 + 2.0 + 0.1, -1]} material={roofMat}>
          <boxGeometry args={[1.2, 0.2, 1.15]} />
        </mesh>

        {/* ── Entrance (front face, ground floor) ─────────────────────── */}
        {/* Dark recessed opening */}
        <mesh position={[0, -3.55, FRONT_Z + 0.02]} material={deckMat}>
          <boxGeometry args={[1.95, 3.5, 0.06]} />
        </mesh>
        {/* Door leaf, set into the opening */}
        <mesh position={[0, -3.7, FRONT_Z + 0.06]} material={doorMat}>
          <boxGeometry args={[1.5, 3.0, 0.08]} />
        </mesh>
        {/* Proud frame surround — left jamb, right jamb, lintel */}
        <mesh position={[-1.05, -3.45, FRONT_Z + 0.09]} material={frameMat}>
          <boxGeometry args={[0.2, 3.7, 0.18]} />
        </mesh>
        <mesh position={[1.05, -3.45, FRONT_Z + 0.09]} material={frameMat}>
          <boxGeometry args={[0.2, 3.7, 0.18]} />
        </mesh>
        <mesh position={[0, -1.7, FRONT_Z + 0.09]} material={frameMat}>
          <boxGeometry args={[2.3, 0.24, 0.18]} />
        </mesh>
        {/* Entrance canopy */}
        <mesh position={[0, -1.55, FRONT_Z + 0.35]} material={roofMat}>
          <boxGeometry args={[2.7, 0.16, 0.72]} />
        </mesh>
        {/* Warm mint light strip under the canopy */}
        <mesh position={[0, -1.9, FRONT_Z + 0.14]} material={porchMat}>
          <boxGeometry args={[1.7, 0.1, 0.08]} />
        </mesh>
        {/* Stoop / steps */}
        <mesh position={[0, -5.45, FRONT_Z + 0.55]} material={trimMat}>
          <boxGeometry args={[2.8, 0.5, 1.0]} />
        </mesh>
        <mesh position={[0, -5.75, FRONT_Z + 1.0]} material={trimMat}>
          <boxGeometry args={[3.4, 0.26, 1.5]} />
        </mesh>
        {/* Nameplate — a small faintly-lit sign beside the door */}
        <mesh position={[1.6, -3.35, FRONT_Z + 0.07]} material={plateMat}>
          <boxGeometry args={[0.86, 0.42, 0.06]} />
        </mesh>
        <mesh position={[1.6, -3.35, FRONT_Z + 0.11]} material={deckMat}>
          <boxGeometry args={[0.62, 0.24, 0.02]} />
        </mesh>

        {/* Entrance apron — the bit of "sidewalk" at the door */}
        <mesh position={[0, BASE + 0.04, FRONT_Z + 1.0]} material={apronMat}>
          <boxGeometry args={[4.4, 0.06, 2.4]} />
        </mesh>

        {/* ── Street lamps flanking the entrance ──────────────────────── */}
        {[-2.7, 2.7].map((lx) => (
          <group key={`lamp-${lx}`} position={[lx, 0, FRONT_Z + 0.7]}>
            <mesh position={[0, BASE + 1.6, 0]} material={darkMat}>
              <cylinderGeometry args={[0.07, 0.09, 3.2, 6]} />
            </mesh>
            <mesh position={[0, BASE + 3.35, 0]} material={lampMat}>
              <boxGeometry args={[0.34, 0.44, 0.34]} />
            </mesh>
            <mesh
              rotation={[-Math.PI / 2, 0, 0]}
              position={[0, BASE + 0.075, 0]}
              material={poolMat}
            >
              <circleGeometry args={[1.0, 20]} />
            </mesh>
          </group>
        ))}

        {/* Warm porch fill — real light, gives the recess its depth */}
        <pointLight
          color="#ADE0C5"
          intensity={1.4}
          distance={7}
          decay={2}
          position={[0, -3.2, FRONT_Z + 1.2]}
        />

        {/* Selective balconies — slabs + rails, one draw call each */}
        <instancedMesh
          ref={slabRef}
          args={[slabGeo, balconyMat, balconies.length]}
          frustumCulled={false}
        />
        <instancedMesh
          ref={railRef}
          args={[railGeo, railMat, balconies.length]}
          frustumCulled={false}
        />

        {/* Window frames — 1 draw call */}
        <instancedMesh
          ref={frameRef}
          args={[frameGeo, frameMat, WIN_COUNT]}
          frustumCulled={false}
        />
        {/* Glowing panes — 1 draw call */}
        <instancedMesh ref={paneRef} args={[paneGeo, paneMat, WIN_COUNT]} frustumCulled={false} />
      </group>
    </group>
  )
}

export const Building = BuildingImpl
