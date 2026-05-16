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
const LIT_PROB = 0.52 // ~52% lit — the building always feels alive
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

// One window's "apartment": which atlas scene it shows when lit, whether
// it flickers like a TV, and a stable per-window seed for animation.
type WindowState = {
  lit: boolean
  value: number
  next: number
  tv: boolean
  seed: number
}

// Stable per-window pseudo-random — keeps the balcony layout identical
// across reloads (real buildings don't rearrange their balconies).
const hash = (i: number, f: number) => (((i * 73856093) ^ (f * 19349663)) >>> 0) % 100

// ── Window-life atlas ─────────────────────────────────────────────────
// A 5×5 grid of hand-drawn "apartment interiors": dark silhouettes on a
// warm / cool / green lit background. One CanvasTexture, sampled per
// instance via the `aCell` attribute → all 98 windows in ONE draw call.
const ATLAS = 5 // 5 cols × 5 rows
const CELL = 132 // px per cell

type SceneType =
  | 'standing'
  | 'sitting'
  | 'tv'
  | 'lamp'
  | 'plant'
  | 'two'
  | 'curtain'
  | 'cat'
  | 'empty'

// Animation flag baked per cell: 0 none · 1 subtle person sway · 2 curtain.
type Cell = { type: SceneType; flag: number }

const SIL = '#05070E' // silhouette ink — reads as pure shadow
const COOL = [108, 140, 228] // overhead electric light
const WARM = [240, 176, 96] // lamp / candle
const GREEN = [126, 198, 156] // TV spill

/** Builds the scene atlas on a 2D canvas and returns the texture + the
 *  per-cell type/flag table used to assign windows. Client-only. */
function buildAtlas(): { texture: THREE.Texture; cells: Cell[] } {
  const size = ATLAS * CELL
  const cv = document.createElement('canvas')
  cv.width = size
  cv.height = size
  const x = cv.getContext('2d')!

  const lerp = (a: number, b: number, t: number) => a + (b - a) * t
  const rgb = (c: number[], m = 1) =>
    `rgb(${Math.round(c[0] * m)},${Math.round(c[1] * m)},${Math.round(c[2] * m)})`

  // Soft lit interior: brighter toward the ceiling, dimmer at the floor.
  const room = (ox: number, oy: number, base: number[]) => {
    const g = x.createLinearGradient(0, oy, 0, oy + CELL)
    g.addColorStop(0, rgb(base, 1.15))
    g.addColorStop(0.55, rgb(base, 0.92))
    g.addColorStop(1, rgb(base, 0.6))
    x.fillStyle = g
    x.fillRect(ox, oy, CELL, CELL)
  }
  // A glowing light source (lamp / screen).
  const bulb = (cx: number, cy: number, r: number, col: number[]) => {
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, r)
    g.addColorStop(0, 'rgba(255,253,245,0.95)')
    g.addColorStop(0.4, rgb(col, 1.2))
    g.addColorStop(1, 'rgba(0,0,0,0)')
    x.fillStyle = g
    x.beginPath()
    x.arc(cx, cy, r, 0, Math.PI * 2)
    x.fill()
  }
  x.fillStyle = SIL
  const person = (ox: number, oy: number, px: number, scale = 1) => {
    const fy = oy + CELL
    const hw = 11 * scale // half body width
    x.beginPath() // body
    x.moveTo(px - hw, fy)
    x.quadraticCurveTo(px - hw, oy + CELL * 0.42, px, oy + CELL * 0.4)
    x.quadraticCurveTo(px + hw, oy + CELL * 0.42, px + hw, fy)
    x.closePath()
    x.fill()
    x.beginPath() // head
    x.arc(px, oy + CELL * 0.34, 9 * scale, 0, Math.PI * 2)
    x.fill()
  }

  const draw: Record<SceneType, ((ox: number, oy: number, v: number) => void)[]> = {
    standing: [
      (o, p) => {
        room(o, p, COOL)
        person(o, p, o + CELL * 0.5, 1)
      },
      (o, p) => {
        room(o, p, COOL)
        person(o, p, o + CELL * 0.62, 0.95)
      },
    ],
    sitting: [
      (o, p) => {
        room(o, p, COOL)
        bulb(o + CELL * 0.66, p + CELL * 0.52, 26, COOL)
        x.fillStyle = SIL
        x.fillRect(o + CELL * 0.22, p + CELL * 0.5, 26, CELL * 0.5) // hunched torso
        x.beginPath()
        x.arc(o + CELL * 0.3, p + CELL * 0.48, 9, 0, Math.PI * 2)
        x.fill()
        x.fillRect(o + CELL * 0.58, p + CELL * 0.46, 22, 16) // screen
      },
      (o, p) => {
        room(o, p, WARM)
        x.fillStyle = SIL
        x.fillRect(o + CELL * 0.3, p + CELL * 0.52, 30, CELL * 0.48)
        x.beginPath()
        x.arc(o + CELL * 0.36, p + CELL * 0.5, 10, 0, Math.PI * 2)
        x.fill()
      },
      (o, p) => {
        room(o, p, COOL)
        bulb(o + CELL * 0.36, p + CELL * 0.55, 24, COOL)
        x.fillStyle = SIL
        x.fillRect(o + CELL * 0.5, p + CELL * 0.5, 28, CELL * 0.5)
        x.beginPath()
        x.arc(o + CELL * 0.57, p + CELL * 0.47, 10, 0, Math.PI * 2)
        x.fill()
      },
    ],
    tv: [
      (o, p) => {
        room(o, p, GREEN)
        bulb(o + CELL * 0.5, p + CELL * 0.42, 40, GREEN)
        x.fillStyle = SIL
        x.fillRect(o + CELL * 0.28, p + CELL * 0.62, CELL * 0.44, CELL * 0.38) // couch
      },
      (o, p) => {
        room(o, p, GREEN)
        bulb(o + CELL * 0.46, p + CELL * 0.46, 34, GREEN)
        x.fillStyle = SIL
        x.fillRect(o + CELL * 0.34, p + CELL * 0.5, 24, CELL * 0.5) // viewer
        x.beginPath()
        x.arc(o + CELL * 0.4, p + CELL * 0.48, 9, 0, Math.PI * 2)
        x.fill()
      },
    ],
    lamp: [
      (o, p) => {
        room(o, p, WARM)
        bulb(o + CELL * 0.7, p + CELL * 0.4, 30, WARM)
      },
      (o, p) => {
        room(o, p, WARM)
        bulb(o + CELL * 0.32, p + CELL * 0.46, 26, WARM)
        x.fillStyle = SIL
        x.fillRect(o + CELL * 0.28, p + CELL * 0.6, 6, CELL * 0.4) // lamp stand
      },
      (o, p) => {
        room(o, p, WARM)
        bulb(o + CELL * 0.6, p + CELL * 0.5, 24, WARM)
        x.fillStyle = SIL
        x.fillRect(o + CELL * 0.16, p + CELL * 0.58, 22, CELL * 0.42) // someone nearby
      },
    ],
    plant: [
      (o, p) => {
        room(o, p, COOL)
        x.fillStyle = SIL
        x.fillRect(o + CELL * 0.42, p + CELL * 0.78, 18, CELL * 0.22) // pot
        for (let i = 0; i < 5; i++) {
          x.beginPath()
          x.ellipse(
            o + CELL * (0.5 + Math.cos(i) * 0.13),
            p + CELL * (0.62 - i * 0.04),
            7,
            13,
            i,
            0,
            Math.PI * 2,
          )
          x.fill()
        }
      },
      (o, p) => {
        room(o, p, WARM)
        x.fillStyle = SIL
        x.fillRect(o + CELL * 0.2, p + CELL * 0.8, 14, CELL * 0.2)
        for (let i = 0; i < 4; i++) {
          x.beginPath()
          x.ellipse(o + CELL * 0.27, p + CELL * (0.7 - i * 0.06), 6, 14, 0.4 * i, 0, Math.PI * 2)
          x.fill()
        }
      },
    ],
    two: [
      (o, p) => {
        room(o, p, WARM)
        person(o, p, o + CELL * 0.34, 0.88)
        person(o, p, o + CELL * 0.66, 0.88)
      },
      (o, p) => {
        room(o, p, COOL)
        person(o, p, o + CELL * 0.38, 0.9)
        person(o, p, o + CELL * 0.64, 0.82)
      },
    ],
    curtain: [
      (o, p) => {
        room(o, p, COOL)
        for (let i = 0; i < 7; i++) {
          x.fillStyle = `rgba(5,7,14,${i % 2 ? 0.34 : 0.16})`
          x.fillRect(o + (CELL / 7) * i, p, CELL / 7 + 1, CELL)
        }
      },
      (o, p) => {
        room(o, p, WARM)
        for (let i = 0; i < 6; i++) {
          x.fillStyle = `rgba(5,7,14,${i % 2 ? 0.3 : 0.12})`
          x.fillRect(o + (CELL / 6) * i, p, CELL / 6 + 1, CELL)
        }
      },
    ],
    cat: [
      (o, p) => {
        room(o, p, WARM)
        x.fillStyle = SIL
        x.beginPath() // loaf body
        x.ellipse(o + CELL * 0.5, p + CELL * 0.86, 26, 15, 0, 0, Math.PI * 2)
        x.fill()
        x.beginPath() // head
        x.arc(o + CELL * 0.68, p + CELL * 0.78, 11, 0, Math.PI * 2)
        x.fill()
        x.beginPath() // ears
        x.moveTo(o + CELL * 0.63, p + CELL * 0.71)
        x.lineTo(o + CELL * 0.66, p + CELL * 0.63)
        x.lineTo(o + CELL * 0.7, p + CELL * 0.71)
        x.fill()
      },
    ],
    empty: [
      (o, p) => room(o, p, COOL),
      (o, p) => {
        room(o, p, WARM)
        x.fillStyle = 'rgba(5,7,14,0.22)'
        x.fillRect(o + CELL * 0.15, p + CELL * 0.7, CELL * 0.35, CELL * 0.3) // shelf
      },
      (o, p) =>
        room(o, p, [lerp(COOL[0], 60, 0.5), lerp(COOL[1], 70, 0.5), lerp(COOL[2], 110, 0.5)]),
      (o, p) => room(o, p, COOL),
    ],
  }

  // Fixed layout so the grid is full and assignment is deterministic.
  const order: { type: SceneType; variant: number }[] = []
  ;(Object.keys(draw) as SceneType[]).forEach((type) =>
    draw[type].forEach((_, variant) => order.push({ type, variant })),
  )
  while (order.length < ATLAS * ATLAS) order.push({ type: 'empty', variant: 0 })

  const cells: Cell[] = order.map(({ type, variant }, i) => {
    const ox = (i % ATLAS) * CELL
    const oy = Math.floor(i / ATLAS) * CELL
    draw[type][variant](ox, oy, 0)
    const flag =
      type === 'curtain' ? 2 : type === 'standing' || type === 'sitting' || type === 'two' ? 1 : 0
    return { type, flag }
  })

  const texture = new THREE.CanvasTexture(cv)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.flipY = false
  texture.generateMipmaps = false
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  return { texture, cells }
}

// Scene mix (% of windows). Each window keeps its scene for the whole
// session — its "apartment" — and shows it whenever its lights are on.
const WEIGHTS: [SceneType, number][] = [
  ['standing', 10],
  ['sitting', 15],
  ['tv', 10],
  ['lamp', 15],
  ['plant', 10],
  ['two', 5],
  ['curtain', 10],
  ['cat', 3],
  ['empty', 22],
]

/**
 * A 5-floor Scandinavian "hyreshus" you can tell people *live* in.
 * Body + parapet roof + chimney + plinth + framed windows on all four
 * faces + selective balconies + a recessed lit entrance, sitting on a
 * static gridded ground while the lot rotates. Every lit window shows
 * one of 25 apartment scenes — silhouettes of people, lamps, TVs,
 * plants, cats, moving curtains — in cool / warm / green light.
 *
 * Performance: every pane is ONE InstancedMesh and every frame another;
 * the life scenes are a single CanvasTexture atlas sampled per instance
 * via `aCell` (no extra geometry, no extra draw calls). Curtain/sway is
 * a shader UV ripple gated by `aFlag`; TV flicker rides the existing
 * per-window glow lerp. One `uTime` uniform / frame, zero React
 * re-renders. ~33 draw calls, <3k tris → solid 60fps with full life.
 */
function BuildingImpl({ animate = true }: { animate?: boolean }) {
  const groupRef = useRef<THREE.Group>(null)
  const paneRef = useRef<THREE.InstancedMesh>(null)
  const frameRef = useRef<THREE.InstancedMesh>(null)
  const slabRef = useRef<THREE.InstancedMesh>(null)
  const railRef = useRef<THREE.InstancedMesh>(null)
  const shaderRef = useRef<THREE.WebGLProgramParametersWithUniforms | null>(null)

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

  // The window-life atlas (client only).
  const atlas = useMemo(() => (typeof document === 'undefined' ? null : buildAtlas()), [])

  // Per-instance buffers, uploaded to the GPU.
  const glow = useMemo(() => new Float32Array(WIN_COUNT), [WIN_COUNT])
  const cellBuf = useMemo(() => new Float32Array(WIN_COUNT), [WIN_COUNT])
  const flagBuf = useMemo(() => new Float32Array(WIN_COUNT), [WIN_COUNT])

  const paneGeo = useMemo(() => {
    // Large glass so the scene reads; sits proud of the slim frame.
    const g = new THREE.BoxGeometry(1.32, 1.78, 0.1)
    g.setAttribute('aGlow', new THREE.InstancedBufferAttribute(glow, 1))
    g.setAttribute('aCell', new THREE.InstancedBufferAttribute(cellBuf, 1))
    g.setAttribute('aFlag', new THREE.InstancedBufferAttribute(flagBuf, 1))
    return g
  }, [glow, cellBuf, flagBuf])
  const frameGeo = useMemo(() => new THREE.BoxGeometry(1.5, 1.98, 0.06), [])
  const slabGeo = useMemo(() => new THREE.BoxGeometry(1.5, 0.12, 0.78), [])
  const railGeo = useMemo(() => new THREE.BoxGeometry(1.5, 0.56, 0.05), [])

  // Window panes: emissive = sampled apartment-scene texel × per-window
  // glow. Curtain/sway windows ripple their UV in the shader.
  const paneMat = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({
      color: '#10182E',
      metalness: 0.2,
      roughness: 0.4,
    })
    m.emissive = new THREE.Color('#ffffff')
    m.emissiveIntensity = 1
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = { value: 0 }
      shader.uniforms.uAtlas = { value: atlas?.texture ?? null }
      // `uv` is already declared by three's attribute setup — declaring
      // it again fails shader compile. Our instanced attrs are custom.
      shader.vertexShader =
        'attribute float aGlow;\nattribute float aCell;\nattribute float aFlag;\n' +
        'varying float vGlow;\nvarying float vCell;\nvarying float vFlag;\nvarying vec2 vWUv;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n  vGlow = aGlow;\n  vCell = aCell;\n  vFlag = aFlag;\n  vWUv = uv;',
        )
      shader.fragmentShader =
        'varying float vGlow;\nvarying float vCell;\nvarying float vFlag;\nvarying vec2 vWUv;\n' +
        'uniform float uTime;\nuniform sampler2D uAtlas;\n' +
        shader.fragmentShader.replace(
          'vec3 totalEmissiveRadiance = emissive;',
          `vec2 _uv = clamp(vWUv, 0.0, 1.0);
           float _amp = vFlag > 1.5 ? 0.020 : (vFlag > 0.5 ? 0.006 : 0.0);
           _uv.x += sin(uTime * 1.5 + vCell * 2.3 + _uv.y * 6.2831) * _amp;
           _uv = clamp(_uv, 0.0, 1.0);
           float _N = ${ATLAS}.0;
           vec2 _c = vec2(mod(vCell, _N), floor(vCell / _N));
           vec2 _auv = (_c + vec2(0.04) + _uv * 0.92) / _N;
           vec3 _interior = texture2D(uAtlas, _auv).rgb;
           vec3 totalEmissiveRadiance = _interior * vGlow * 1.3;`,
        )
      shaderRef.current = shader
    }
    m.customProgramCacheKey = () => 'eveno-window-life-v2'
    return m
  }, [atlas])

  const bodyMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#0F1F47', metalness: 0.45, roughness: 0.55 }),
    [],
  )
  const frameMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#9AAAD0', roughness: 0.55 }),
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
  const balconyMat = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#1C2D58', roughness: 0.6 }),
    [],
  )
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

  // One-time: place all instanced meshes, assign each window an
  // apartment scene, and seed the lighting state.
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

    // Glass proud (front face ≈ +0.11); frame recessed behind it (≈ +0.03)
    // so the emissive scene is never occluded by the surround.
    setInstances(paneRef.current, placements, 0.06, 0)
    setInstances(frameRef.current, placements, 0.0, 0)
    setInstances(slabRef.current, balconies, 0.42, -0.92)
    setInstances(railRef.current, balconies, 0.78, -0.64)

    const cells = atlas?.cells ?? []
    const cellsByType = new Map<SceneType, number[]>()
    cells.forEach((c, idx) => {
      const a = cellsByType.get(c.type) ?? []
      a.push(idx)
      cellsByType.set(c.type, a)
    })
    const totalW = WEIGHTS.reduce((s, [, w]) => s + w, 0)
    const pickType = (): SceneType => {
      let r = Math.random() * totalW
      for (const [t, w] of WEIGHTS) {
        r -= w
        if (r <= 0) return t
      }
      return 'empty'
    }

    windowState.current = placements.map((_, i) => {
      const type = pickType()
      const pool = cellsByType.get(type) ?? cellsByType.get('empty') ?? [0]
      const ci = pool[(Math.random() * pool.length) | 0]
      cellBuf[i] = ci
      flagBuf[i] = cells[ci]?.flag ?? 0
      const lit = Math.random() < LIT_PROB
      glow[i] = lit ? LIT_INTENSITY : 0
      return {
        lit,
        value: glow[i],
        next: 1 + Math.random() * 5,
        tv: type === 'tv',
        seed: Math.random() * 100,
      }
    })

    const geo = paneRef.current?.geometry
    if (geo) {
      geo.attributes.aGlow.needsUpdate = true
      geo.attributes.aCell.needsUpdate = true
      geo.attributes.aFlag.needsUpdate = true
    }
  }, [placements, balconies, glow, cellBuf, flagBuf, atlas])

  useFrame((state, delta) => {
    if (!animate) return

    const group = groupRef.current
    if (group) group.rotation.y += delta * ((Math.PI * 2) / 60)

    const t = state.clock.elapsedTime
    if (shaderRef.current) shaderRef.current.uniforms.uTime.value = t

    // Frame-rate-independent smoothing → ~1.5s settle; TVs respond fast.
    const k = 1 - Math.exp(-delta / 0.55)
    const kTv = 1 - Math.exp(-delta / 0.07)
    const win = windowState.current
    for (let i = 0; i < win.length; i++) {
      const w = win[i]
      if (t > w.next) {
        w.lit = Math.random() < LIT_PROB
        w.next = t + 2.5 + Math.random() * 4.5
      }
      let target = w.lit ? LIT_INTENSITY : 0
      if (w.tv && w.lit) {
        // Restless screen: fast jitter + slower scene-cut pulses.
        const f = 0.74 + 0.2 * Math.sin(t * 12 + w.seed) + 0.12 * Math.sin(t * 31 + w.seed * 2)
        target = LIT_INTENSITY * Math.max(0.4, f)
        w.value += (target - w.value) * kTv
      } else {
        w.value += (target - w.value) * k
      }
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
        {/* Living panes — 1 draw call, scene atlas sampled per instance */}
        <instancedMesh ref={paneRef} args={[paneGeo, paneMat, WIN_COUNT]} frustumCulled={false} />
      </group>
    </group>
  )
}

export const Building = BuildingImpl
