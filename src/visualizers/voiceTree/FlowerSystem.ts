import * as THREE from 'three'

function easeOutCubic(t: number): number {
  const p = Math.min(1, Math.max(0, t))
  return 1 - (1 - p) ** 3
}

function computeRms(timeDomain: Uint8Array): number {
  if (timeDomain.length === 0) return 0
  let s = 0
  for (let i = 0; i < timeDomain.length; i++) {
    const v = (timeDomain[i]! - 128) / 128
    s += v * v
  }
  return Math.sqrt(s / timeDomain.length)
}

function colorFromRms(rms: number): THREE.Color {
  const blue = new THREE.Color(0x4890dc)
  const pink = new THREE.Color(0xf08edf)
  if (rms <= 0.05) return blue.clone()
  if (rms >= 0.15) return pink.clone()
  const t = Math.min(1, Math.max(0, (rms - 0.05) / 0.1))
  return blue.clone().lerp(pink, t)
}

function sampleGrowPoints(points: THREE.Vector3[], maxFlowers: number): THREE.Vector3[] {
  if (points.length === 0) return []
  if (points.length <= maxFlowers) return points.map(p => p.clone())
  const out: THREE.Vector3[] = []
  for (let i = 0; i < maxFlowers; i++) {
    const t = maxFlowers <= 1 ? 0 : i / (maxFlowers - 1)
    const idx = Math.round(t * (points.length - 1))
    out.push(points[idx]!.clone())
  }
  return out
}

function buildWingShape(): THREE.Shape {
  const shape = new THREE.Shape()
  shape.moveTo(0, 0)
  shape.bezierCurveTo(0.3, 0.4, 0.6, 0.4, 0.5, 0)
  shape.bezierCurveTo(0.6, -0.3, 0.2, -0.3, 0, 0)
  return shape
}

type FlowerInst = {
  group: THREE.Group
  fillMats: THREE.MeshBasicMaterial[]
  spawnStartedAt: number
}

/**
 * Phase 2：根据麦克风在枝头/节点开花（蝴蝶形双瓣 × 双层材质）
 */
export class FlowerSystem {
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private root = new THREE.Group()
  private flowers: FlowerInst[] = []
  private sampledPoints: THREE.Vector3[] = []
  private growPointsSet = false

  private speakingTimer = 0
  private silentTimer = 0
  private flowersVisible = false
  private currentScale = 0
  private lastWallMs = 0
  /** 平滑后的音量，避免字间 RMS 掉底导致计时清零、花瓣闪没 */
  private rmsSmoothed = 0

  maxFlowers = 20
  baseScale = 0.42
  scaleBoost = 2.2
  /** 持续有说话意图的最短累计时间（秒）；计时用平滑 RMS + 衰减，见 update */
  bloomThreshold = 0.45
  fadeTime = 2.0
  /** 低于此视为「静音」用于长静音淡出；略低于字间气口 */
  private readonly voiceGate = 0.015

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.scene = scene
    this.camera = camera
    this.root.name = 'flowerSystemPhase2'
    this.root.renderOrder = 10
    scene.add(this.root)
  }

  setGrowPoints(points: THREE.Vector3[]): void {
    this.sampledPoints = sampleGrowPoints(points, this.maxFlowers)
    this.growPointsSet = true
  }

  private clearFlowersFromScene() {
    for (const f of this.flowers) {
      this.root.remove(f.group)
      f.group.traverse(obj => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose()
          const mat = obj.material
          if (Array.isArray(mat)) mat.forEach(m => m.dispose())
          else mat.dispose()
        }
      })
    }
    this.flowers = []
  }

  private createWingMeshes(): { layer1: THREE.Mesh; layer2: THREE.Mesh; fillMat: THREE.MeshBasicMaterial } {
    const shape = buildWingShape()
    const geo = new THREE.ShapeGeometry(shape)
    const outlineMat = new THREE.MeshBasicMaterial({
      color: 0x29efb5,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    })
    const fillMat = new THREE.MeshBasicMaterial({
      color: 0x4890dc,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    })
    const layer1 = new THREE.Mesh(geo, outlineMat)
    layer1.scale.setScalar(1.15)
    layer1.renderOrder = 0
    const layer2 = new THREE.Mesh(geo.clone(), fillMat)
    layer2.renderOrder = 1
    return { layer1, layer2, fillMat }
  }

  private spawnAllFlowers(nowSec: number) {
    this.clearFlowersFromScene()

    for (const pos of this.sampledPoints) {
      const flower = new THREE.Group()
      flower.position.copy(pos)

      const left = new THREE.Group()
      const wL = this.createWingMeshes()
      left.add(wL.layer1, wL.layer2)

      const right = new THREE.Group()
      right.scale.x = -1
      const wR = this.createWingMeshes()
      right.add(wR.layer1, wR.layer2)

      flower.add(left, right)

      const fillMats = [wL.fillMat, wR.fillMat]
      flower.renderOrder = 10
      this.flowers.push({
        group: flower,
        fillMats,
        spawnStartedAt: nowSec,
      })
      this.root.add(flower)
    }
  }

  update(timeDomain: Uint8Array, _frequency: Uint8Array): void {
    void _frequency
    if (!this.growPointsSet || this.sampledPoints.length === 0) return

    const now = performance.now()
    const dt = this.lastWallMs > 0 ? Math.min(0.1, (now - this.lastWallMs) / 1000) : 1 / 60
    this.lastWallMs = now
    const nowSec = now / 1000

    const rawRms = computeRms(timeDomain)
    this.rmsSmoothed += (rawRms - this.rmsSmoothed) * 0.12
    const voice = this.rmsSmoothed

    // 开花累计：有声音就涨；小声时缓慢衰减，不要一字一清零（否则永远到不了阈值）
    if (voice > this.voiceGate) {
      this.speakingTimer += dt
    } else {
      this.speakingTimer = Math.max(0, this.speakingTimer - dt * 1.1)
    }

    // 长静音检测：仅用于淡出并移除，与上面独立
    if (voice < this.voiceGate) {
      this.silentTimer += dt
    } else {
      this.silentTimer = 0
    }

    if (!this.flowersVisible && this.speakingTimer > this.bloomThreshold) {
      this.spawnAllFlowers(nowSec)
      this.flowersVisible = true
      this.currentScale = 0
    }

    const c = colorFromRms(voice)

    let targetScale = 0
    if (this.flowersVisible) {
      if (this.silentTimer > this.fadeTime) {
        targetScale = 0
      } else {
        // 字间 RMS 变低时仍保持可见体量，只靠「长静音」真正收掉
        const pulse = this.baseScale + voice * this.scaleBoost
        targetScale = Math.max(this.baseScale * 0.4, pulse)
      }
    }

    this.currentScale += (targetScale - this.currentScale) * 0.08

    for (const f of this.flowers) {
      for (const m of f.fillMats) {
        m.color.copy(c)
      }
      f.group.quaternion.copy(this.camera.quaternion)
      const age = nowSec - f.spawnStartedAt
      const spawnT = Math.min(1, age / 0.6)
      const ease = easeOutCubic(spawnT)
      const s = ease * this.currentScale
      f.group.scale.setScalar(Math.max(0, s))
    }

    if (this.flowersVisible && this.silentTimer > this.fadeTime && this.currentScale < 0.002) {
      this.clearFlowersFromScene()
      this.flowersVisible = false
      this.speakingTimer = 0
      this.silentTimer = 0
    }
  }

  dispose(): void {
    this.clearFlowersFromScene()
    this.scene.remove(this.root)
  }
}
