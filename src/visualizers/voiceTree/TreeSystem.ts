import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'

interface Branch {
  start: THREE.Vector3
  end: THREE.Vector3
  level: number
  mesh: THREE.Mesh | null
  swayOffset: number
  growthComplete?: boolean
}

/** flower discs: lower tier = canopy / outer tips preferred in sampling */
export type FlowerAnchorKind = 'tip' | 'mid'

export interface FlowerAnchor {
  id: string
  tier: number
  kind: FlowerAnchorKind
  branchIndex: number
}

/** Procedural tree tuning (keep stable to preserve silhouette). */
const TREE_GEN = {
  gScale: 0.9,
  /** Extra spread (rad) for L2/L3 branches */
  angle5: (5 * Math.PI) / 180,
} as const

export class TreeSystem {
  private renderer!: THREE.WebGLRenderer
  private scene!: THREE.Scene
  private camera!: THREE.PerspectiveCamera
  private animFrameId: number | null = null
  private treeGroup!: THREE.Group
  private seed!: THREE.Mesh
  private branches: Branch[] = []
  private dirLight!: THREE.DirectionalLight
  private groundMesh!: THREE.Mesh
  /** Tinted shadow catcher over the pink plane (Three shadows are grayscale; color comes from ShadowMaterial). */
  private shadowCatcher!: THREE.Mesh
  private composer!: EffectComposer
  private bloomPass!: UnrealBloomPass

  private readonly groundSurfaceY = 0.01
  private readonly groundPlaneSize = 5
  private readonly treeGroupBaseY = 0.02
  private readonly trunkTopY = 0.98

  private forkSphereKeys = new Set<string>()
  private tipCapKeys = new Set<string>()

  private readonly jointRadiusByLevel = [0.118, 0.078, 0.032, 0.02, 0.012]
  private readonly trunkNeckRadius = 0.0812

  private readonly branchGrowDurationSec = 0.55
  private activeGrowths: { branchIndex: number; mesh: THREE.Mesh; t0: number }[] = []

  private deferredL1Grow = false

  /** Seed idle → float → fall → on ground (hidden when trunk shows). */
  private seedPhase: 'none' | 'float' | 'fall' | 'ground' = 'none'
  private seedFloatStartSec = 0
  private seedFallStartSec = 0
  private seedFallFromY = 0
  private readonly seedFloatDurationSec = 1
  private readonly seedFallDurationSec = 0.55
  private readonly seedFloatHeight = 1.12
  private readonly seedOnGroundY = 0.018

  private readonly treeBranchColor = 0x5cf5e8
  private readonly treeBranchEmissive = 0xa7f3d0

  private static readonly WORLD_UP = new THREE.Vector3(0, 1, 0)

  /** Lathe seed: compact teardrop; bottom at y=0 after translate. */
  private createSeedGeometry(): THREE.BufferGeometry {
    const pts = [
      new THREE.Vector2(0.002, 0),
      new THREE.Vector2(0.04, 0.02),
      new THREE.Vector2(0.068, 0.05),
      new THREE.Vector2(0.076, 0.082),
      new THREE.Vector2(0.072, 0.108),
      new THREE.Vector2(0.055, 0.13),
      new THREE.Vector2(0.028, 0.146),
      new THREE.Vector2(0.006, 0.156),
      new THREE.Vector2(0.001, 0.158),
    ]
    const geo = new THREE.LatheGeometry(pts, 40)
    geo.computeBoundingBox()
    const minY = geo.boundingBox!.min.y
    geo.translate(0, -minY, 0)
    return geo
  }

  constructor(container: HTMLElement, width: number, height: number) {
    this.initRenderer(container, width, height)
    this.initSceneAndContent(width, height)
    this.branches = this.buildBranchData()
    this.initComposer(width, height)
    this.animate()
  }

  private initRenderer(container: HTMLElement, width: number, height: number) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setSize(width, height)
    this.renderer.setPixelRatio(window.devicePixelRatio)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.NoToneMapping
    this.renderer.toneMappingExposure = 1.06
    container.appendChild(this.renderer.domElement)
  }

  private initSceneAndContent(width: number, height: number) {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x004eda)
    this.treeGroup = new THREE.Group()
    this.treeGroup.position.y = this.treeGroupBaseY
    this.scene.add(this.treeGroup)

    // Dolly toward subject; camZoom ≈ framing tightness (1.8 here).
    const camZoom = 1.8
    const camLookAt = new THREE.Vector3(0, 1.52, 0)
    const camPos = new THREE.Vector3(0, 3.55, 5.85)
    const camPosDolly = camLookAt.clone().add(camPos.clone().sub(camLookAt).divideScalar(camZoom))

    this.camera = new THREE.PerspectiveCamera(58, width / height, 0.1, 100)
    this.camera.position.copy(camPosDolly)
    this.camera.lookAt(camLookAt)

    this.scene.add(new THREE.AmbientLight(0xf5eeff, 0.46))
    this.scene.add(new THREE.HemisphereLight(0x9cb0ff, 0x3d2848, 0.36))

    this.dirLight = new THREE.DirectionalLight(0xffffff, 1.32)
    this.dirLight.position.set(4.5, 7, 3.5)
    this.dirLight.castShadow = true
    this.dirLight.shadow.mapSize.set(2048, 2048)
    this.dirLight.shadow.camera.near = 0.5
    this.dirLight.shadow.camera.far = 52
    this.dirLight.shadow.camera.left = -8
    this.dirLight.shadow.camera.right = 8
    this.dirLight.shadow.camera.top = 8
    this.dirLight.shadow.camera.bottom = -8
    this.dirLight.shadow.bias = -0.0004
    this.dirLight.shadow.normalBias = 0.045
    this.dirLight.target.position.set(0, 1.75, 0)
    this.scene.add(this.dirLight)
    this.scene.add(this.dirLight.target)

    const groundGeo = new THREE.PlaneGeometry(this.groundPlaneSize, this.groundPlaneSize)
    this.groundMesh = new THREE.Mesh(
      groundGeo,
      new THREE.MeshStandardMaterial({ color: 0xffc8e4, roughness: 0.68, metalness: 0.05 })
    )
    this.groundMesh.rotation.x = -Math.PI / 2
    this.groundMesh.position.y = this.groundSurfaceY
    this.groundMesh.receiveShadow = false
    this.scene.add(this.groundMesh)

    this.shadowCatcher = new THREE.Mesh(
      new THREE.PlaneGeometry(this.groundPlaneSize, this.groundPlaneSize),
      new THREE.ShadowMaterial({
        color: 0x4890dc,
        transparent: true,
        opacity: 0.88,
        depthWrite: false,
      })
    )
    this.shadowCatcher.rotation.x = -Math.PI / 2
    this.shadowCatcher.position.y = this.groundSurfaceY + 0.004
    this.shadowCatcher.receiveShadow = true
    this.shadowCatcher.renderOrder = 1
    this.scene.add(this.shadowCatcher)

    this.seed = new THREE.Mesh(
      this.createSeedGeometry(),
      new THREE.MeshStandardMaterial({
        color: 0xe4ebe5,
        emissive: 0x9ed4c4,
        emissiveIntensity: 0.085,
        roughness: 0.52,
        metalness: 0.02,
      })
    )
    this.seed.position.set(0, this.groundSurfaceY + this.seedFloatHeight, 0)
    this.seed.castShadow = true
    this.seed.receiveShadow = false
    this.seed.visible = false
    this.scene.add(this.seed)
  }

  private initComposer(width: number, height: number) {
    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), 0.26, 0.24, 0.48)
    this.composer.addPass(this.bloomPass)
  }

  /** Procedural topology; keep weights/order stable or silhouette changes. */
  private buildBranchData(): Branch[] {
    const out: Branch[] = []
    const trunkTop = new THREE.Vector3(0, this.trunkTopY, 0)
    const gScale = TREE_GEN.gScale
    const extraSpreadL23 = TREE_GEN.angle5
    const deg5 = TREE_GEN.angle5

    out.push({
      start: new THREE.Vector3(0, 0, 0),
      end: trunkTop.clone(),
      level: 0,
      mesh: null,
      swayOffset: 0,
    })

    const l1Phase = Math.PI / 2
    const inwardArm = Math.floor(Math.random() * 3)
    const l1Ends: THREE.Vector3[] = []
    for (let i = 0; i < 3; i++) {
      const sway = (Math.random() - 0.5) * 0.36
      const ang = l1Phase + (i * 2 * Math.PI) / 3 + sway
      const lenScale = 0.52 + Math.random() * 0.42
      let horiz = 1.08 * lenScale
      let up = 0.36 + Math.random() * 0.26

      let end: THREE.Vector3
      if (i === inwardArm) {
        up *= 0.86 + Math.random() * 0.04
        horiz *= 1.06 + Math.random() * 0.05
        const ox = Math.cos(ang) * horiz
        const oz = Math.sin(ang) * horiz
        const rH = Math.hypot(ox, oz) || 1
        const pull = (0.26 + Math.random() * 0.1) * horiz
        const vx = ox - (ox / rH) * pull
        const vz = oz - (oz / rH) * pull
        end = trunkTop.clone().add(new THREE.Vector3(vx, up, vz))
      } else {
        end = trunkTop.clone().add(
          new THREE.Vector3(Math.cos(ang) * horiz, up, Math.sin(ang) * horiz)
        )
      }
      end = this.tiltL1Endpoint(end, trunkTop, deg5)
      out.push({
        start: trunkTop.clone(),
        end,
        level: 1,
        mesh: null,
        swayOffset: Math.random() * Math.PI * 2,
      })
      l1Ends.push(end)
    }

    const l2Tips: { tip: THREE.Vector3; parentStart: THREE.Vector3 }[] = []

    l1Ends.forEach(l1Tip => {
      const base = trunkTop.clone()
      const incoming = new THREE.Vector3().subVectors(l1Tip, base).normalize()
      const { t1, t2 } = this.orthonormalBasis(incoming)
      const radial = new THREE.Vector3(l1Tip.x, 0, l1Tip.z)
      const hasR = radial.lengthSq() > 1e-8
      if (hasR) radial.normalize()

      const pushL2 = (origin: THREE.Vector3, phaseBase: number) => {
        const phase = phaseBase + (Math.random() - 0.5) * 0.38
        let spread = 0.2 + Math.random() * 0.2
        if (Math.random() < 0.45) {
          spread += 0.08 + Math.random() * 0.18
        }
        spread += extraSpreadL23
        const dir = incoming
          .clone()
          .add(t1.clone().multiplyScalar(Math.cos(phase) * spread))
          .add(t2.clone().multiplyScalar(Math.sin(phase) * spread))
        if (hasR) {
          const outward = Math.random() < 0.5
          const bump = 0.22 + Math.random() * 0.48
          dir.add(radial.clone().multiplyScalar(outward ? bump : -bump))
        }
        dir.normalize()
        const len = (0.42 + Math.random() * 0.48) * gScale
        const end = origin.clone().add(dir.clone().multiplyScalar(len))
        out.push({
          start: origin.clone(),
          end,
          level: 2,
          mesh: null,
          swayOffset: Math.random() * Math.PI * 2,
        })
        l2Tips.push({ tip: end, parentStart: origin.clone() })
      }

      const nMid = 1 + (Math.random() < 0.52 ? 1 : 0)
      const nTip = 1 + (Math.random() < 0.52 ? 1 : 0)

      for (let j = 0; j < nMid; j++) {
        const t = 0.32 + j * 0.11 + Math.random() * 0.14
        const midPt = new THREE.Vector3().lerpVectors(base, l1Tip, Math.min(t, 0.58))
        const phaseBase = (j * Math.PI) / Math.max(nMid, 1)
        pushL2(midPt, phaseBase)
      }
      for (let j = 0; j < nTip; j++) {
        const phaseBase = (j * 2 * Math.PI) / Math.max(nTip, 1)
        pushL2(l1Tip, phaseBase)
      }
    })

    l2Tips.forEach(({ tip, parentStart }) => {
      const incoming = new THREE.Vector3().subVectors(tip, parentStart).normalize()
      const { t1, t2 } = this.orthonormalBasis(incoming)
      const radial2 = new THREE.Vector3(tip.x, 0, tip.z)
      const hasR2 = radial2.lengthSq() > 1e-8
      if (hasR2) radial2.normalize()

      for (let k = 0; k < 3; k++) {
        let spread = 0.14 + Math.random() * 0.16
        if (Math.random() < 0.4) {
          spread += 0.06 + Math.random() * 0.14
        }
        spread += extraSpreadL23
        const phase = (k * 2 * Math.PI) / 3 + (Math.random() - 0.5) * 0.48
        const dir = incoming
          .clone()
          .add(t1.clone().multiplyScalar(Math.cos(phase) * spread))
          .add(t2.clone().multiplyScalar(Math.sin(phase) * spread))
        if (hasR2 && Math.random() < 0.55) {
          const outward = Math.random() < 0.5
          dir.add(radial2.clone().multiplyScalar((outward ? 1 : -1) * (0.12 + Math.random() * 0.38)))
        }
        dir.normalize()
        let len: number
        if (Math.random() < 0.38) {
          len = (0.1 + Math.random() * 0.16) * gScale
        } else {
          len = (0.28 + Math.random() * 0.42) * gScale
        }
        const end = tip.clone().add(dir.clone().multiplyScalar(len))
        out.push({
          start: tip.clone(),
          end,
          level: 3,
          mesh: null,
          swayOffset: (k * Math.PI) / 3,
        })
      }
    })

    return out
  }

  private jointRadiusAtLevel(level: number): number {
    const i = Math.min(level, this.jointRadiusByLevel.length - 1)
    return this.jointRadiusByLevel[i]
  }

  private vecKey(v: THREE.Vector3): string {
    const q = (n: number) => n.toFixed(4)
    return `${q(v.x)},${q(v.y)},${q(v.z)}`
  }

  private tiltDirTowardWorldUp(dir: THREE.Vector3, deltaRad: number): THREE.Vector3 {
    const d = dir.clone().normalize()
    const axis = new THREE.Vector3().crossVectors(d, TreeSystem.WORLD_UP)
    if (axis.lengthSq() < 1e-12) return d
    axis.normalize()
    return d.applyAxisAngle(axis, deltaRad)
  }

  /** Pull L1 tips slightly toward world up. */
  private tiltL1Endpoint(end: THREE.Vector3, trunkTop: THREE.Vector3, deg5: number): THREE.Vector3 {
    const off = new THREE.Vector3().subVectors(end, trunkTop)
    const len = off.length()
    if (len <= 1e-6) return end
    off.copy(this.tiltDirTowardWorldUp(off, deg5)).multiplyScalar(len)
    return trunkTop.clone().add(off)
  }

  private orthonormalBasis(dir: THREE.Vector3): { t1: THREE.Vector3; t2: THREE.Vector3 } {
    const d = dir.clone().normalize()
    const up = Math.abs(d.y) < 0.85 ? TreeSystem.WORLD_UP : new THREE.Vector3(1, 0, 0)
    const t1 = new THREE.Vector3().crossVectors(up, d).normalize()
    const t2 = new THREE.Vector3().crossVectors(d, t1).normalize()
    return { t1, t2 }
  }

  private branchMaterialForLevel(): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      color: this.treeBranchColor,
      emissive: this.treeBranchEmissive,
      emissiveIntensity: 0.22,
      metalness: 0.18,
      roughness: 0.34,
    })
  }

  private createBranchMesh(b: Branch): THREE.Mesh {
    const axis = new THREE.Vector3().subVectors(b.end, b.start)
    const height = axis.length()
    const rStart =
      b.level === 1 ? this.trunkNeckRadius : this.jointRadiusAtLevel(b.level)
    const rEnd =
      b.level === 0
        ? this.trunkNeckRadius
        : b.level >= 3
          ? Math.max(0.008, this.jointRadiusByLevel[4])
          : this.jointRadiusAtLevel(b.level + 1)
    const segs = b.level >= 2 ? 20 : 16
    const geo = new THREE.CylinderGeometry(rEnd, rStart, height, segs, 1)
    geo.translate(0, height / 2, 0)
    const mesh = new THREE.Mesh(geo, this.branchMaterialForLevel())

    mesh.position.copy(b.start)
    const dir = axis.clone().normalize()
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
    mesh.scale.set(1, 1e-3, 1)
    mesh.castShadow = true
    mesh.receiveShadow = true

    return mesh
  }

  private ensureTipCap(position: THREE.Vector3) {
    const key = this.vecKey(position)
    if (this.tipCapKeys.has(key)) return
    this.tipCapKeys.add(key)
    const r = this.jointRadiusByLevel[3] * 0.65
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(r, 14, 12),
      this.branchMaterialForLevel()
    )
    cap.position.copy(position)
    cap.castShadow = true
    cap.receiveShadow = true
    this.treeGroup.add(cap)
  }

  private forkSphereRadiusAt(position: THREE.Vector3, level: number): number {
    const atTrunkTop =
      Math.abs(position.y - this.trunkTopY) < 0.02 &&
      position.x * position.x + position.z * position.z < 1e-5
    if (atTrunkTop && level === 1) {
      return (this.jointRadiusAtLevel(0) + this.trunkNeckRadius) * 0.5 * 1.1
    }
    return this.jointRadiusAtLevel(level) * 1.14
  }

  private ensureForkSphere(position: THREE.Vector3, level: number) {
    if (position.lengthSq() < 1e-8) return
    const key = this.vecKey(position)
    if (this.forkSphereKeys.has(key)) return
    this.forkSphereKeys.add(key)

    const r = this.forkSphereRadiusAt(position, level)
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(r, 20, 18),
      this.branchMaterialForLevel()
    )
    sphere.position.copy(position)
    sphere.castShadow = true
    sphere.receiveShadow = true
    this.treeGroup.add(sphere)
  }

  private startGrowTrunkOnly() {
    const t0 = performance.now() / 1000
    for (let i = 0; i < this.branches.length; i++) {
      const b = this.branches[i]
      if (b.mesh !== null) continue
      if (b.level === 0) {
        this.startBranchGrowth(i, t0)
        return
      }
    }
  }

  private startGrowL1Only() {
    const t0 = performance.now() / 1000
    for (let i = 0; i < this.branches.length; i++) {
      const b = this.branches[i]
      if (b.mesh !== null) continue
      if (b.level === 1) {
        this.startBranchGrowth(i, t0)
      }
    }
  }

  private startLayerGrow(level: number) {
    const t0 = performance.now() / 1000
    for (let i = 0; i < this.branches.length; i++) {
      const b = this.branches[i]
      if (b.mesh !== null) continue
      if (b.level === level) {
        this.startBranchGrowth(i, t0)
      }
    }
  }

  private startBranchGrowth(branchIndex: number, t0: number) {
    const b = this.branches[branchIndex]
    if (b.mesh !== null) return

    this.ensureForkSphere(b.start, b.level)
    const mesh = this.createBranchMesh(b)
    b.mesh = mesh
    this.treeGroup.add(mesh)
    this.activeGrowths.push({ branchIndex, mesh, t0 })
  }

  private static easeOutCubic(t: number): number {
    const p = Math.min(1, Math.max(0, t))
    return 1 - (1 - p) ** 3
  }

  private updateBranchGrowth(nowSec: number) {
    for (let i = this.activeGrowths.length - 1; i >= 0; i--) {
      const g = this.activeGrowths[i]
      const t = (nowSec - g.t0) / this.branchGrowDurationSec
      const k = TreeSystem.easeOutCubic(t)
      g.mesh.scale.set(1, Math.max(1e-3, k), 1)

      if (t >= 1) {
        const b = this.branches[g.branchIndex]
        g.mesh.scale.set(1, 1, 1)
        b.growthComplete = true
        if (b.level === 3) {
          this.ensureTipCap(b.end)
        }
        this.activeGrowths.splice(i, 1)
        if (b.level === 0 && this.deferredL1Grow) {
          this.deferredL1Grow = false
          this.startGrowL1Only()
        }
      }
    }
  }

  getTips(): THREE.Vector3[] {
    const levels = this.branches.map(b => b.level)
    if (levels.length === 0) return []
    const maxL = Math.max(...levels)
    return this.branches
      .filter(b => b.level === maxL && b.mesh !== null && b.growthComplete)
      .map(b => {
        const v = b.end.clone()
        this.treeGroup.localToWorld(v)
        return v
      })
  }

  getMidPoints(): THREE.Vector3[] {
    return this.branches
      .filter(b => b.level === 2)
      .map(b => {
        const v = new THREE.Vector3().lerpVectors(b.start, b.end, 0.5)
        this.treeGroup.localToWorld(v)
        return v
      })
  }

  /**
   * Tiered attach points for flowers: canopy tips first, then lower tips, then midpoints on branches.
   */
  getFlowerAnchors(): FlowerAnchor[] {
    if (this.branches.length === 0) return []

    const ok = (b: Branch) => b.mesh !== null && b.growthComplete === true
    const maxL = Math.max(...this.branches.map(b => b.level))
    const out: FlowerAnchor[] = []

    const pushEnds = (level: number, tier: number) => {
      this.branches.forEach((b, i) => {
        if (b.level === level && ok(b)) {
          out.push({ id: `tip-L${level}-${i}`, tier, kind: 'tip', branchIndex: i })
        }
      })
    }

    pushEnds(maxL, 0)
    if (maxL >= 1) pushEnds(maxL - 1, 1)
    if (maxL >= 2) pushEnds(maxL - 2, 2)

    let midTier = 3
    for (const L of [3, 2, 1, 0]) {
      this.branches.forEach((b, i) => {
        if (b.level === L && ok(b)) {
          out.push({ id: `mid-L${L}-${i}`, tier: midTier, kind: 'mid', branchIndex: i })
        }
      })
      midTier++
    }

    return out
  }

  /** Branch tip or midpoint in local space + jitter → world (follows treeGroup spin). */
  resolveFlowerAnchorWorldPosition(anchor: FlowerAnchor, jitterLocal: THREE.Vector3): THREE.Vector3 | null {
    const b = this.branches[anchor.branchIndex]
    if (!b || !b.mesh || !b.growthComplete) return null

    const v =
      anchor.kind === 'tip'
        ? b.end.clone()
        : new THREE.Vector3().lerpVectors(b.start, b.end, 0.5)
    v.add(jitterLocal)
    this.treeGroup.updateMatrixWorld(true)
    v.applyMatrix4(this.treeGroup.matrixWorld)
    return v
  }

  getScene(): THREE.Scene {
    return this.scene
  }

  getCamera(): THREE.PerspectiveCamera {
    return this.camera
  }

  onWordDrop(_index: number) {
    void _index
  }

  triggerSeed() {
    this.seed.visible = true
    this.seed.scale.setScalar(1)
    this.seed.position.set(0, this.groundSurfaceY + this.seedFloatHeight, 0)
    this.seedPhase = 'float'
    this.seedFloatStartSec = performance.now() / 1000
  }

  /**
   * level 1: trunk only, then L1 forks. level 2/3: whole layer. Seed hides from line 2 onward.
   */
  triggerGrow(level: number) {
    if (level >= 1) {
      this.seedPhase = 'none'
      this.seed.visible = false
    }
    if (level === 1) {
      this.deferredL1Grow = true
      this.startGrowTrunkOnly()
    } else {
      this.startLayerGrow(level)
    }
    this.treeGroup.position.y = this.treeGroupBaseY
  }

  private updateSeedMotion(nowSec: number) {
    if (this.seedPhase === 'none' || !this.seed.visible) return

    const groundY = this.groundSurfaceY + this.seedOnGroundY

    if (this.seedPhase === 'float') {
      const t = nowSec - this.seedFloatStartSec
      const bob = Math.sin(t * 2.8) * 0.02
      this.seed.position.y = this.groundSurfaceY + this.seedFloatHeight + bob
      if (t >= this.seedFloatDurationSec) {
        this.seedPhase = 'fall'
        this.seedFallStartSec = nowSec
        this.seedFallFromY = this.seed.position.y
      }
      return
    }

    if (this.seedPhase === 'fall') {
      const u = Math.min(1, (nowSec - this.seedFallStartSec) / this.seedFallDurationSec)
      const k = TreeSystem.easeOutCubic(u)
      this.seed.position.y = this.seedFallFromY + (groundY - this.seedFallFromY) * k
      if (u >= 1) {
        this.seed.position.y = groundY
        this.seedPhase = 'ground'
      }
      return
    }
  }

  private animate() {
    this.animFrameId = requestAnimationFrame(() => this.animate())
    const now = performance.now() / 1000
    this.updateBranchGrowth(now)
    this.updateSeedMotion(now)
    this.treeGroup.rotation.y += 0.004
    this.composer.render()
  }

  update(_timeDomain: Uint8Array, _frequency: Uint8Array) {
    void _timeDomain
    void _frequency
  }

  dispose() {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId)
      this.animFrameId = null
    }
    this.seed.geometry.dispose()
    ;(this.seed.material as THREE.MeshStandardMaterial).dispose()
    this.groundMesh.geometry.dispose()
    ;(this.groundMesh.material as THREE.MeshStandardMaterial).dispose()
    this.shadowCatcher.geometry.dispose()
    ;(this.shadowCatcher.material as THREE.ShadowMaterial).dispose()
    this.composer.dispose()
    this.renderer.domElement.remove()
    this.renderer.dispose()
  }
}
