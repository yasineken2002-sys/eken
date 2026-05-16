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

const FRONT_Z = D / 2 // +3 — the face that carries the entrance

// ── Window grid per facade ────────────────────────────────────────────
// Front: 4 windows on upper floors (20/40/60/80% across width), 4 on the
// ground floor flanking the entrance. Back: 3. Sides: 2 each. Every slot
// always renders a full framed window — only lit/unlit varies.
const FRONT_X = [-2.4, -0.8, 0.8, 2.4] // upper floors (4)
const FRONT_GROUND_X = [-3.0, -1.7, 1.7, 3.0] // ground floor, around entrance
const BACK_X = [-2, 0, 2] // 3 windows
const SIDE_Z = [1.5, -1.5] // 2 windows — [front-facing, back-facing]

// Per-facade window sizes (width, height).
const SZ_FRONT: [number, number] = [1.3, 1.75]
const SZ_FRONT_G: [number, number] = [1.3, 1.6]
const SZ_BACK: [number, number] = [1.15, 1.6]
const SZ_SIDE: [number, number] = [0.9, 1.5]

const LIT_INTENSITY = 1.0
const LIT_PROB = 0.5 // ~50% lit — a realistic mix

type Side = 'front' | 'back' | 'right' | 'left'

type Placement = {
  x: number
  y: number
  z: number
  rotY: number
  nx: number // outward normal
  nz: number
  floor: number
  side: Side
  w: number
  h: number
}

type WindowState = { lit: boolean; value: number; next: number }

// French balconies: right side facade only, floors 2–5 (idx 1–4).
const BALCONIES: { floor: number; z: number }[] = [
  { floor: 1, z: 1.5 }, // floor 2 — front-facing window
  { floor: 2, z: -1.5 }, // floor 3 — back-facing window
  { floor: 3, z: 1.5 }, // floor 4 — both windows
  { floor: 3, z: -1.5 },
  { floor: 4, z: 1.5 }, // floor 5 — front-facing window
]
const BAL_PROTRUDE = 0.35
const BAL_WIDTH = 0.95 // ≈ side window width

/**
 * A 5-floor Scandinavian "hyreshus". Every window slot always renders a
 * white-framed, divided window — lit (golden) or unlit (dark blue-grey),
 * never missing. Each facade has a distinct rhythm: front 4/upper floor
 * (clean, no balconies), back 3 (service), sides 2, plus 3 roof dormers.
 * Five wrought-iron French balconies sit on the RIGHT side only, so the
 * architecture changes as the building rotates.
 *
 * Performance: all 55 panes are ONE InstancedMesh, all frames another,
 * the two mullion bars two more; balcony rails/bars are instanced too.
 * Per-window glow is one instanced `aGlow` float scaled into the
 * emissive term via onBeforeCompile — lit/unlit is N float lerps + one
 * buffer upload per frame, no React re-renders. ~40 draw calls, <4k
 * tris → solid 60fps.
 */
function BuildingImpl({ animate = true }: { animate?: boolean }) {
  const groupRef = useRef<THREE.Group>(null)
  const paneRef = useRef<THREE.InstancedMesh>(null)
  const frameRef = useRef<THREE.InstancedMesh>(null)
  const mullVRef = useRef<THREE.InstancedMesh>(null)
  const mullHRef = useRef<THREE.InstancedMesh>(null)
  const balLipRef = useRef<THREE.InstancedMesh>(null)
  const balTopRef = useRef<THREE.InstancedMesh>(null)
  const balBotRef = useRef<THREE.InstancedMesh>(null)
  const balBarRef = useRef<THREE.InstancedMesh>(null)

  // Every window position on the building (always rendered).
  const placements = useMemo<Placement[]>(() => {
    const list: Placement[] = []
    const add = (
      x: number,
      y: number,
      z: number,
      rotY: number,
      nx: number,
      nz: number,
      floor: number,
      side: Side,
      sz: [number, number],
    ) => list.push({ x, y, z, rotY, nx, nz, floor, side, w: sz[0], h: sz[1] })

    ROW_Y.forEach((y, f) => {
      // Front (+z)
      if (f === 0)
        for (const x of FRONT_GROUND_X) add(x, y, FRONT_Z, 0, 0, 1, f, 'front', SZ_FRONT_G)
      else for (const x of FRONT_X) add(x, y, FRONT_Z, 0, 0, 1, f, 'front', SZ_FRONT)
      // Back (−z)
      for (const x of BACK_X) add(x, y, -D / 2, Math.PI, 0, -1, f, 'back', SZ_BACK)
      // Right (+x) and Left (−x)
      for (const z of SIDE_Z) add(W / 2, y, z, Math.PI / 2, 1, 0, f, 'right', SZ_SIDE)
      for (const z of SIDE_Z) add(-W / 2, y, z, -Math.PI / 2, -1, 0, f, 'left', SZ_SIDE)
    })
    return list
  }, [])

  const WIN = placements.length // 55

  const glow = useMemo(() => new Float32Array(WIN), [WIN])

  // Unit geometries — scaled per instance to each window's size.
  const paneGeo = useMemo(() => {
    const g = new THREE.BoxGeometry(1, 1, 0.1)
    g.setAttribute('aGlow', new THREE.InstancedBufferAttribute(glow, 1))
    return g
  }, [glow])
  const unit06 = useMemo(() => new THREE.BoxGeometry(1, 1, 0.06), [])
  const unit03 = useMemo(() => new THREE.BoxGeometry(1, 1, 0.04), [])

  // French-balcony parts (right side). Boxes are authored in the +x
  // face's local axes: x = protrusion, y = height, z = width.
  const balLipGeo = useMemo(() => new THREE.BoxGeometry(BAL_PROTRUDE, 0.05, BAL_WIDTH), [])
  const balBotGeo = useMemo(() => new THREE.BoxGeometry(0.06, 0.05, BAL_WIDTH - 0.02), [])
  const balTopGeo = useMemo(() => new THREE.BoxGeometry(0.07, 0.09, BAL_WIDTH + 0.02), [])
  const balBarGeo = useMemo(() => new THREE.BoxGeometry(0.045, 0.9, 0.045), [])

  // Lit windows glow the same warm gold; unlit show a dark blue-grey
  // glass that is clearly NOT the navy facade.
  const paneMat = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({
      color: '#1A2D5C',
      metalness: 0.15,
      roughness: 0.4,
    })
    m.emissive = new THREE.Color('#FFCB7C')
    m.emissiveIntensity = 1.7
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
    m.customProgramCacheKey = () => 'eveno-window-gold-v3'
    return m
  }, [])

  const bodyMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#0F1F47', metalness: 0.45, roughness: 0.55 }),
    [],
  )
  // Crisp white window frames + mullions — every slot reads clearly.
  const frameMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#F5F5F0', roughness: 0.6 }),
    [],
  )
  const trimMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#0B1A3C', roughness: 0.6 }),
    [],
  )
  const roofMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#16264F', roughness: 0.6 }),
    [],
  )
  const deckMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#070C18', roughness: 0.85 }),
    [],
  )
  const darkMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#0A1226', roughness: 0.7 }),
    [],
  )
  const ironMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#1A1A1A', metalness: 0.4, roughness: 0.5 }),
    [],
  )
  const plantMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#3FA85F', roughness: 0.7 }),
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
  const goldMat = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({ color: '#1A2D5C', roughness: 0.4 })
    m.emissive = new THREE.Color('#FFCB7C')
    m.emissiveIntensity = 1.6
    return m
  }, [])
  const lampMat = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({ color: '#ADE0C5', roughness: 0.4 })
    m.emissive = new THREE.Color('#ADE0C5')
    m.emissiveIntensity = 1.1
    return m
  }, [])
  const porchMat = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({ color: '#ADE0C5', roughness: 0.5 })
    m.emissive = new THREE.Color('#ADE0C5')
    m.emissiveIntensity = 0.6
    return m
  }, [])
  const plateMat = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({ color: '#ADE0C5', roughness: 0.5 })
    m.emissive = new THREE.Color('#ADE0C5')
    m.emissiveIntensity = 0.35
    return m
  }, [])
  const poolMat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: '#ADE0C5', transparent: true, opacity: 0.16 }),
    [],
  )

  const windowState = useRef<WindowState[]>([])

  // One-time: lay out every window (scaled per-instance) + the 5 right-
  // side French balconies, then seed the lighting state.
  useEffect(() => {
    const dummy = new THREE.Object3D()

    const setWindows = (
      mesh: THREE.InstancedMesh | null,
      out: number,
      sx: (p: Placement) => number,
      sy: (p: Placement) => number,
    ) => {
      if (!mesh) return
      placements.forEach((p, i) => {
        dummy.position.set(p.x + p.nx * out, p.y, p.z + p.nz * out)
        dummy.rotation.set(0, p.rotY, 0)
        dummy.scale.set(sx(p), sy(p), 1)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
      })
      dummy.scale.set(1, 1, 1)
      mesh.instanceMatrix.needsUpdate = true
    }

    // Frame sits flush; glass proud; mullions just proud of the glass.
    setWindows(
      frameRef.current,
      0.0,
      (p) => p.w + 0.16,
      (p) => p.h + 0.16,
    )
    setWindows(
      paneRef.current,
      0.06,
      (p) => p.w,
      (p) => p.h,
    )
    setWindows(
      mullVRef.current,
      0.105,
      () => 0.05,
      (p) => p.h - 0.04,
    )
    setWindows(
      mullHRef.current,
      0.105,
      (p) => p.w - 0.04,
      () => 0.05,
    )

    // ── French balconies (right side, +x face) ────────────────────────
    const RX = W / 2 // +4
    const place = (mesh: THREE.InstancedMesh, i: number, x: number, y: number, z: number) => {
      dummy.position.set(x, y, z)
      dummy.rotation.set(0, 0, 0)
      dummy.scale.set(1, 1, 1)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    }
    BALCONIES.forEach((b, i) => {
      const y = ROW_Y[b.floor]
      const botY = y - 0.55
      const topY = y + 0.35
      if (balLipRef.current) place(balLipRef.current, i, RX + BAL_PROTRUDE / 2, botY - 0.04, b.z)
      if (balBotRef.current) place(balBotRef.current, i, RX + BAL_PROTRUDE, botY, b.z)
      if (balTopRef.current) place(balTopRef.current, i, RX + BAL_PROTRUDE, topY, b.z)
      const offs = [-0.36, -0.12, 0.12, 0.36]
      offs.forEach((o, k) => {
        if (balBarRef.current)
          place(balBarRef.current, i * 4 + k, RX + BAL_PROTRUDE, (botY + topY) / 2, b.z + o)
      })
    })
    ;[balLipRef, balBotRef, balTopRef, balBarRef].forEach(
      (r) => r.current && (r.current.instanceMatrix.needsUpdate = true),
    )

    windowState.current = placements.map((_, i) => {
      const lit = Math.random() < LIT_PROB
      glow[i] = lit ? LIT_INTENSITY : 0
      return { lit, value: glow[i], next: 1 + Math.random() * 5 }
    })
    if (paneRef.current) paneRef.current.geometry.attributes.aGlow.needsUpdate = true
  }, [placements, glow])

  useFrame((state, delta) => {
    if (!animate) return

    const group = groupRef.current
    if (group) group.rotation.y += delta * ((Math.PI * 2) / 60)

    const t = state.clock.elapsedTime
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

  // 3 roof dormers — small lit attic windows, set back from the parapet.
  const dormers = useMemo(() => [-2.2, 0, 2.2], [])

  return (
    <group>
      {/* ── Static ground (the turntable / city floor) ──────────────── */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, BASE - 0.02, 0]} material={groundMat}>
        <planeGeometry args={[64, 64]} />
      </mesh>
      <gridHelper args={[64, 32, '#1A2547', '#121A33']} position={[0, BASE + 0.005, 0]} />

      {/* ── The rotating "lot" — building + entrance furniture ───────── */}
      <group ref={groupRef} rotation={[0, -0.32, 0]}>
        {/* Foundation plinth */}
        <mesh position={[0, BASE + 0.4, 0]} material={darkMat}>
          <boxGeometry args={[W + 0.3, 0.8, D + 0.3]} />
        </mesh>

        {/* Main body */}
        <mesh material={bodyMat}>
          <boxGeometry args={[W, H, D]} />
        </mesh>

        {/* Horizontal floor lines */}
        {separators.map((y) => (
          <mesh key={`sep-${y}`} position={[0, y, 0]} material={trimMat}>
            <boxGeometry args={[W + 0.06, 0.13, D + 0.06]} />
          </mesh>
        ))}

        {/* Flat roof with parapet + inset deck */}
        <mesh position={[0, TOP + 0.4, 0]} material={roofMat}>
          <boxGeometry args={[W + 0.35, 0.8, D + 0.35]} />
        </mesh>
        <mesh position={[0, TOP + 0.25, 0]} material={deckMat}>
          <boxGeometry args={[W - 0.5, 0.6, D - 0.5]} />
        </mesh>

        {/* 3 roof dormers — small lit attic windows */}
        {dormers.map((dx) => (
          <group key={`dorm-${dx}`} position={[dx, TOP + 1.05, D / 2 - 1.1]}>
            <mesh material={roofMat}>
              <boxGeometry args={[1.0, 0.95, 0.7]} />
            </mesh>
            <mesh position={[0, 0.02, 0.37]} material={frameMat}>
              <boxGeometry args={[0.62, 0.6, 0.05]} />
            </mesh>
            <mesh position={[0, 0.02, 0.4]} material={goldMat}>
              <boxGeometry args={[0.48, 0.46, 0.04]} />
            </mesh>
          </group>
        ))}

        {/* Chimney */}
        <mesh position={[-2.4, TOP + 0.8 + 1.0, -1]} material={bodyMat}>
          <boxGeometry args={[1.0, 2.0, 0.95]} />
        </mesh>
        <mesh position={[-2.4, TOP + 0.8 + 2.0 + 0.1, -1]} material={roofMat}>
          <boxGeometry args={[1.2, 0.2, 1.15]} />
        </mesh>

        {/* ── Entrance (front face, ground floor) ─────────────────────── */}
        <mesh position={[0, -3.55, FRONT_Z + 0.02]} material={deckMat}>
          <boxGeometry args={[1.95, 3.5, 0.06]} />
        </mesh>
        <mesh position={[0, -3.7, FRONT_Z + 0.06]} material={doorMat}>
          <boxGeometry args={[1.5, 3.0, 0.08]} />
        </mesh>
        <mesh position={[-1.05, -3.45, FRONT_Z + 0.09]} material={frameMat}>
          <boxGeometry args={[0.2, 3.7, 0.18]} />
        </mesh>
        <mesh position={[1.05, -3.45, FRONT_Z + 0.09]} material={frameMat}>
          <boxGeometry args={[0.2, 3.7, 0.18]} />
        </mesh>
        <mesh position={[0, -1.7, FRONT_Z + 0.09]} material={frameMat}>
          <boxGeometry args={[2.3, 0.24, 0.18]} />
        </mesh>
        <mesh position={[0, -1.55, FRONT_Z + 0.35]} material={roofMat}>
          <boxGeometry args={[2.7, 0.16, 0.72]} />
        </mesh>
        <mesh position={[0, -1.9, FRONT_Z + 0.14]} material={porchMat}>
          <boxGeometry args={[1.7, 0.1, 0.08]} />
        </mesh>
        <mesh position={[0, -5.45, FRONT_Z + 0.55]} material={trimMat}>
          <boxGeometry args={[2.8, 0.5, 1.0]} />
        </mesh>
        <mesh position={[0, -5.75, FRONT_Z + 1.0]} material={trimMat}>
          <boxGeometry args={[3.4, 0.26, 1.5]} />
        </mesh>
        <mesh position={[1.55, -2.5, FRONT_Z + 0.07]} material={plateMat}>
          <boxGeometry args={[0.8, 0.4, 0.06]} />
        </mesh>
        <mesh position={[1.55, -2.5, FRONT_Z + 0.11]} material={deckMat}>
          <boxGeometry args={[0.58, 0.22, 0.02]} />
        </mesh>

        {/* Entrance apron */}
        <mesh position={[0, BASE + 0.04, FRONT_Z + 1.0]} material={apronMat}>
          <boxGeometry args={[4.4, 0.06, 2.4]} />
        </mesh>

        {/* Street lamps flanking the entrance */}
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

        <pointLight
          color="#ADE0C5"
          intensity={1.4}
          distance={7}
          decay={2}
          position={[0, -3.2, FRONT_Z + 1.2]}
        />

        {/* ── French balconies — RIGHT side facade only ───────────────── */}
        <instancedMesh
          ref={balLipRef}
          args={[balLipGeo, ironMat, BALCONIES.length]}
          frustumCulled={false}
        />
        <instancedMesh
          ref={balBotRef}
          args={[balBotGeo, ironMat, BALCONIES.length]}
          frustumCulled={false}
        />
        <instancedMesh
          ref={balTopRef}
          args={[balTopGeo, ironMat, BALCONIES.length]}
          frustumCulled={false}
        />
        <instancedMesh
          ref={balBarRef}
          args={[balBarGeo, ironMat, BALCONIES.length * 4]}
          frustumCulled={false}
        />
        {/* A couple of balconies have a small potted plant */}
        <mesh
          position={[W / 2 + BAL_PROTRUDE - 0.05, ROW_Y[1] - 0.45, 1.5 + 0.34]}
          material={plantMat}
        >
          <boxGeometry args={[0.14, 0.2, 0.14]} />
        </mesh>
        <mesh
          position={[W / 2 + BAL_PROTRUDE - 0.05, ROW_Y[3] - 0.45, -1.5 - 0.34]}
          material={plantMat}
        >
          <boxGeometry args={[0.14, 0.2, 0.14]} />
        </mesh>

        {/* ── Windows: every slot, always framed ──────────────────────── */}
        <instancedMesh ref={frameRef} args={[unit06, frameMat, WIN]} frustumCulled={false} />
        <instancedMesh ref={paneRef} args={[paneGeo, paneMat, WIN]} frustumCulled={false} />
        <instancedMesh ref={mullVRef} args={[unit03, frameMat, WIN]} frustumCulled={false} />
        <instancedMesh ref={mullHRef} args={[unit03, frameMat, WIN]} frustumCulled={false} />
      </group>
    </group>
  )
}

export const Building = BuildingImpl
