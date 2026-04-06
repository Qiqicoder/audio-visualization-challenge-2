import * as THREE from 'three'
import type { FlowerAnchor, TreeSystem } from './TreeSystem'

/**
 * Mic-driven discs on tree anchors: pitch tints fill, loudness drives spawn rate + elastic scale.
 */

const SMOOTH = 0.22
const COOLDOWN_MS_MIN = 6
const COOLDOWN_MS_MAX = 52
const LIFE_MS_MIN = 2600
const LIFE_MS_MAX = 10800
const MAX_DISCS_MIN = 72
const MAX_DISCS_MAX = 240

const W_TIME = 0.55
const W_FREQ = 0.45

/** Voice gates: relative-to-noise RMS (quiet-friendly). */
const RMS_ABOVE_NOISE = 0.026
const RMS_VOICE_MIN = 0.016
const RMS_SOFT_ABOVE = 0.009
const LOW_MEAN_WHISPER = 0.024
const COMBINED_WHISPER_MIN = 0.038

const NOISE_FOLLOW = 0.052
const QUIET_EXTRA = 0.016

/** Weight sampling: higher tier = smaller weight (canopy still favored). */
const TIER_WEIGHT_K = 0.42
const TIP_WEIGHT_BOOST = 1.1

/** Hue smoothing / stretch for fill color. */
const PITCH_SMOOTH = 0.32
const PITCH_CONTRAST = 1.78

const COLOR_FILL_LOW = new THREE.Color(0x0a6cff)
const COLOR_FILL_HIGH = new THREE.Color(0xff2db4)
const COLOR_STROKE = new THREE.Color(0x5cffdc)

/** Scale envelope: fast attack, slow release. */
const SIZE_FOLLOW_UP = 0.56
const SIZE_FOLLOW_DOWN = 0.14
const SIZE_SILENCE_DECAY = 0.11
const SCALE_MIN = 0.34
const SCALE_MAX = 1.98
const SCALE_LOUD_EXP = 0.68
const ELASTIC_WOBBLE_HZ = 0.0135
const ELASTIC_WOBBLE_AMP = 0.158
const ELASTIC_FLUTTER_HZ = 0.03
const ELASTIC_FLUTTER_AMP = 0.065
const ELASTIC_BOUNCE_HZ = 0.045
const ELASTIC_BOUNCE_AMP = 0.042

type Disc = {
  group: THREE.Group
  fillMat: THREE.MeshBasicMaterial
  ringMat: THREE.MeshBasicMaterial
  t0: number
  lifeMs: number
  anchor: FlowerAnchor
  jitterLocal: THREE.Vector3
}

function randomJitterLocal(): THREE.Vector3 {
  return new THREE.Vector3(
    (Math.random() - 0.5) * 0.048,
    (Math.random() - 0.5) * 0.042,
    (Math.random() - 0.5) * 0.048
  )
}

export class FlowerSystem {
  private readonly scene: THREE.Scene
  private readonly camera: THREE.PerspectiveCamera
  private readonly tree: TreeSystem
  private anchors: FlowerAnchor[] = []
  private readonly geoFill: THREE.CircleGeometry
  private readonly geoRing: THREE.RingGeometry
  private readonly discs: Disc[] = []
  private lastSpawn = 0
  private energySmooth = 0
  private noiseRmsEstimate = 0
  private pitchSmooth = 0.5
  private readonly scratchColor = new THREE.Color()
  /** Smoothed loudness (0–1) for motion. */
  private elasticLoudness = 0
  /** Peaks slightly ahead of elasticLoudness for bigger discs when loud. */
  private loudnessForScale = 0

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, tree: TreeSystem) {
    this.scene = scene
    this.camera = camera
    this.tree = tree
    const fillR = 0.046
    const ringInner = fillR
    const ringOuter = 0.058
    this.geoFill = new THREE.CircleGeometry(fillR, 32)
    this.geoRing = new THREE.RingGeometry(ringInner, ringOuter, 32)
  }

  syncAnchors(list: FlowerAnchor[]) {
    this.anchors = list.length > 0 ? list.map(a => ({ ...a })) : []
  }

  /**
   * Pitch tint: mid-band centroid + high/mid energy tilt + zero-cross rate (speech, not only claps).
   */
  private pitchTFromAudio(timeDomain: Uint8Array, frequency: Uint8Array): number {
    const n = frequency.length
    if (n < 16) return this.pitchSmooth

    const i0 = Math.max(2, Math.floor(n * 0.035))
    const i1 = Math.min(n - 1, Math.floor(n * 0.34))

    let wSum = 0
    let iSum = 0
    for (let i = i0; i <= i1; i++) {
      const v = frequency[i]! * (1 / 255)
      const w = v * v + 1e-4
      iSum += i * w
      wSum += w
    }

    let tCent = 0.45
    if (wSum > 1e-5) {
      const c = iSum / wSum
      tCent = (c - i0) / (i1 - i0 + 1e-6)
      tCent = THREE.MathUtils.clamp(tCent, 0, 1)
      tCent = Math.pow(tCent, 0.82)
    }

    const iSplit = Math.max(i0 + 1, Math.floor(n * 0.11))
    const iEnd = Math.min(n - 1, Math.floor(n * 0.44))
    let eLo = 0
    let eHi = 0
    for (let i = i0; i < iSplit && i <= iEnd; i++) {
      const v = frequency[i]! * (1 / 255)
      eLo += v * v
    }
    for (let i = iSplit; i <= iEnd; i++) {
      const v = frequency[i]! * (1 / 255)
      eHi += v * v
    }
    const tilt = eHi / (eLo + eHi + 1e-8)
    const tTilt = THREE.MathUtils.clamp((tilt - 0.07) / 0.34, 0, 1)

    let tZcr = 0.45
    const nTd = timeDomain.length
    if (nTd >= 64) {
      let crossings = 0
      const mid = 128
      for (let i = 1; i < nTd; i++) {
        const a = timeDomain[i - 1]!
        const b = timeDomain[i]!
        if ((a < mid) !== (b < mid)) crossings++
      }
      const z = crossings / (nTd - 1)
      tZcr = THREE.MathUtils.clamp((z - 0.018) / 0.095, 0, 1)
    }

    let t = 0.36 * tCent + 0.4 * tTilt + 0.24 * tZcr
    t = THREE.MathUtils.clamp(t, 0, 1)
    t = THREE.MathUtils.clamp((t - 0.5) * PITCH_CONTRAST + 0.5, 0, 1)
    t = THREE.MathUtils.smoothstep(t, 0, 1)
    return t
  }

  private sampleAnalyser(timeDomain: Uint8Array, frequency: Uint8Array): { rms: number; lowMean: number; combined: number } {
    let rms = 0
    const nTd = timeDomain.length
    if (nTd > 0) {
      let s = 0
      for (let i = 0; i < nTd; i++) {
        const d = (timeDomain[i]! - 128) / 128
        s += d * d
      }
      rms = Math.sqrt(s / nTd)
    }

    let lowMean = 0
    const nF = Math.min(frequency.length, 12)
    if (nF > 0) {
      let sum = 0
      for (let i = 0; i < nF; i++) sum += frequency[i]!
      lowMean = sum / nF / 255
    }

    const combined = Math.min(1, Math.max(0, W_TIME * rms + W_FREQ * lowMean))
    return { rms, lowMean, combined }
  }

  /** Weighted random anchor; tier 0 (canopy tips) most likely. */
  private pickAnchor(): { anchor: FlowerAnchor; jitterLocal: THREE.Vector3 } | null {
    if (this.anchors.length === 0) return null

    let total = 0
    const weights: number[] = []
    for (const a of this.anchors) {
      const base = 1 / (1 + a.tier * TIER_WEIGHT_K)
      const w = base * (a.kind === 'tip' ? TIP_WEIGHT_BOOST : 1)
      weights.push(w)
      total += w
    }

    let r = Math.random() * total
    for (let i = 0; i < this.anchors.length; i++) {
      r -= weights[i]!
      if (r <= 0) {
        return { anchor: this.anchors[i]!, jitterLocal: randomJitterLocal() }
      }
    }
    const last = this.anchors[this.anchors.length - 1]!
    return { anchor: last, jitterLocal: randomJitterLocal() }
  }

  update(timeDomain: Uint8Array, frequency: Uint8Array) {
    if (timeDomain.length === 0 && frequency.length === 0) return

    const rawPitch = this.pitchTFromAudio(timeDomain, frequency)
    this.pitchSmooth += (rawPitch - this.pitchSmooth) * PITCH_SMOOTH
    this.scratchColor.copy(COLOR_FILL_LOW).lerp(COLOR_FILL_HIGH, this.pitchSmooth)
    const { h, s: sat, l } = this.scratchColor.getHSL({ h: 0, s: 0, l: 0 })
    this.scratchColor.setHSL(h, THREE.MathUtils.clamp(sat * 1.12, 0, 1), THREE.MathUtils.clamp(l * 1.06, 0, 1))

    const { rms, lowMean, combined } = this.sampleAnalyser(timeDomain, frequency)

    if (rms < this.noiseRmsEstimate + QUIET_EXTRA) {
      this.noiseRmsEstimate += (rms - this.noiseRmsEstimate) * NOISE_FOLLOW
    }

    const rmsVoiced =
      rms >= RMS_VOICE_MIN && rms >= this.noiseRmsEstimate + RMS_ABOVE_NOISE
    const whisperVoiced =
      rms >= this.noiseRmsEstimate + RMS_SOFT_ABOVE &&
      lowMean >= LOW_MEAN_WHISPER &&
      combined >= COMBINED_WHISPER_MIN
    const softVoiced =
      rms >= this.noiseRmsEstimate + 0.004 &&
      lowMean >= 0.018 &&
      combined >= 0.03

    const voiced = rmsVoiced || whisperVoiced || softVoiced

    const now = performance.now()
    this.energySmooth += (combined - this.energySmooth) * SMOOTH

    const loudnessTarget = Math.min(1, combined * 1.08 + rms * 1.14 + lowMean * 0.32)
    const up = loudnessTarget > this.elasticLoudness
    const k = up ? SIZE_FOLLOW_UP : (voiced ? SIZE_FOLLOW_DOWN : SIZE_SILENCE_DECAY)
    this.elasticLoudness += (loudnessTarget - this.elasticLoudness) * k
    if (!voiced) {
      this.elasticLoudness += (0 - this.elasticLoudness) * (SIZE_SILENCE_DECAY * 0.65)
    }
    this.elasticLoudness = THREE.MathUtils.clamp(this.elasticLoudness, 0, 1)

    this.loudnessForScale = THREE.MathUtils.clamp(
      Math.max(this.elasticLoudness, combined * 0.95 + rms * 0.58),
      0,
      1
    )

    const drive = voiced
      ? Math.min(1, Math.max(this.energySmooth, combined * 1.05, rms * 1.35, lowMean * 1.1))
      : 0

    const maxDiscs = Math.round(MAX_DISCS_MIN + drive * (MAX_DISCS_MAX - MAX_DISCS_MIN))
    const cooldown = COOLDOWN_MS_MAX - drive * (COOLDOWN_MS_MAX - COOLDOWN_MS_MIN)

    if (
      voiced &&
      this.anchors.length > 0 &&
      now - this.lastSpawn >= cooldown &&
      this.discs.length < maxDiscs
    ) {
      const level = Math.max(combined, rms * 1.35, lowMean * 1.15)
      const sustainExtra = Math.min(14, Math.floor(this.energySmooth * 7))
      const burst = 3 + Math.min(32, Math.floor(level * 18)) + sustainExtra
      for (let k = 0; k < burst && this.discs.length < maxDiscs; k++) {
        const picked = this.pickAnchor()
        if (!picked) break
        const lifeMs = LIFE_MS_MIN + Math.min(1, Math.max(combined, rms * 1.15)) * (LIFE_MS_MAX - LIFE_MS_MIN)
        this.spawn(now, lifeMs, picked.anchor, picked.jitterLocal)
      }
      this.lastSpawn = now
    }

    const q = this.camera.quaternion
    const opacityDrive = voiced ? Math.max(this.energySmooth, drive) : this.energySmooth * 0.35

    for (let i = this.discs.length - 1; i >= 0; i--) {
      const d = this.discs[i]!
      const age = now - d.t0
      const u = age / d.lifeMs
      if (u >= 1) {
        this.scene.remove(d.group)
        d.fillMat.dispose()
        d.ringMat.dispose()
        this.discs.splice(i, 1)
        continue
      }

      const world = this.tree.resolveFlowerAnchorWorldPosition(d.anchor, d.jitterLocal)
      if (!world) {
        this.scene.remove(d.group)
        d.fillMat.dispose()
        d.ringMat.dispose()
        this.discs.splice(i, 1)
        continue
      }

      d.group.position.copy(world)
      d.group.quaternion.copy(q)
      d.fillMat.color.copy(this.scratchColor)

      const fadeIn = Math.min(1, age / Math.min(55, d.lifeMs * 0.06))
      const fadeOut = 1 - Math.max(0, (age - d.lifeMs * 0.5) / (d.lifeMs * 0.5)) ** 2
      const shade = fadeIn * fadeOut * (0.99 + 0.01 * opacityDrive)
      const op = Math.min(1, shade)
      d.fillMat.opacity = op
      d.ringMat.opacity = Math.min(1, op)

      const ln = this.loudnessForScale
      const baseScale = THREE.MathUtils.lerp(SCALE_MIN, SCALE_MAX, Math.pow(ln, SCALE_LOUD_EXP))
      const scaleBirth = Math.min(1, fadeIn * 0.82 + 0.18)
      const wobble =
        1 +
        Math.sin(now * ELASTIC_WOBBLE_HZ + d.t0 * 0.0018 + i * 0.31) *
          ELASTIC_WOBBLE_AMP *
          (0.22 + 0.78 * ln)
      const flutter =
        1 + Math.sin(now * ELASTIC_FLUTTER_HZ + age * 0.004) * ELASTIC_FLUTTER_AMP * ln
      const bounce =
        1 +
        Math.abs(Math.sin(now * ELASTIC_BOUNCE_HZ + age * 0.009 + i * 0.17)) *
          ELASTIC_BOUNCE_AMP *
          ln
      const lifeShrink = fadeOut * 0.12 + 0.88
      d.group.scale.setScalar(baseScale * scaleBirth * wobble * flutter * bounce * lifeShrink)
    }
  }

  private spawn(now: number, lifeMs: number, anchor: FlowerAnchor, jitterLocal: THREE.Vector3) {
    const world = this.tree.resolveFlowerAnchorWorldPosition(anchor, jitterLocal)
    if (!world) return

    const ringMat = new THREE.MeshBasicMaterial({
      color: COLOR_STROKE,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
    const fillMat = new THREE.MeshBasicMaterial({
      color: this.scratchColor.clone(),
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    })

    const ring = new THREE.Mesh(this.geoRing, ringMat)
    const fill = new THREE.Mesh(this.geoFill, fillMat)
    ring.renderOrder = 0
    fill.renderOrder = 1

    const group = new THREE.Group()
    group.add(ring)
    group.add(fill)
    group.position.copy(world)
    group.quaternion.copy(this.camera.quaternion)

    this.scene.add(group)
    this.discs.push({
      group,
      fillMat,
      ringMat,
      t0: now,
      lifeMs,
      anchor: { ...anchor },
      jitterLocal: jitterLocal.clone(),
    })
  }

  dispose() {
    for (const d of this.discs) {
      this.scene.remove(d.group)
      d.fillMat.dispose()
      d.ringMat.dispose()
    }
    this.discs.length = 0
    this.geoFill.dispose()
    this.geoRing.dispose()
    this.anchors.length = 0
  }
}
