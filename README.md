# Avora Spring Audio Challenge 2026

Create your own novel audio visualization using real-time microphone input.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173 and allow microphone access when prompted.

## The challenge

The starter brief expects you to edit the visualizer. In this repo, the main scene lives under `src/visualizers/`.

## Audio pipeline

The `useAudio` hook captures microphone input.

From the hook you receive:

- **frequencyData** — 1024 FFT frequency bins from low to high.
- **timeDomainData** — 2048 raw waveform samples. A value of 128 is silence; 0 and 255 are the lowest and highest values respectively.

**Do not modify** `useAudio`; use its return values for your visualization.

## Project structure

```
src/
├── audio/
│   └── useAudio.ts           # Mic + analyser (challenge: leave as-is)
├── visualizers/
│   ├── poem.ts                 # Poem lines, overlay copy, speech keywords
│   ├── Visualizer.tsx           # Composes 3D tree + 2D word overlay + dev controls
│   ├── voiceTree/
│   │   ├── VoiceTreeVisualizer.ts  # Scene entry: tree + flowers + speech wiring
│   │   ├── TreeSystem.ts           # Procedural tree mesh, growth, camera path
│   │   ├── FlowerSystem.ts         # Flower particles tied to word anchors
│   │   └── SpeechHandler.ts        # Web Speech API → keyword callbacks
│   └── wordFx/
│       └── WordOverlay.tsx     # Canvas/HTML word rain + landing effects
├── App.tsx
├── App.css
├── index.css
└── main.tsx
```

## Visualizer: how it is split

- **`poem.ts`** — Single source of truth for the four lines: words for the overlay, keywords for speech recognition to advance the tree, and a total word count for progress UI.

- **`Visualizer.tsx`** — Orchestration only: mounts the Three.js visualizer in a container, drives the word overlay timing from the same poem metadata, and exposes a small dev affordance (skip to “listening” / bloom) that calls into the tree visualizer.

- **`VoiceTreeVisualizer.ts`** — Owns the Three.js scene, lighting, and resize: creates `TreeSystem` and `FlowerSystem`, connects `SpeechHandler` to growth/flower triggers, and tears everything down on dispose.

- **`TreeSystem.ts`** — Geometry and motion: seed → trunk/branches, camera dolly, anchor points where spoken words attach visually; exposes hooks the flowers use.

- **`FlowerSystem.ts`** — Instanced flower geometry and easing so blooms appear at branch anchors when lines complete.

- **`SpeechHandler.ts`** — Wraps `SpeechRecognition` (with `webkit` fallback), normalizes transcripts, matches keywords per line, and restarts recognition until dispose.

- **`WordOverlay.tsx`** — The 2D layer: independent of Three.js; animates falling words and impact effects over the 3D frame.

This separation keeps **content** (`poem.ts`), **3D behavior** (`voiceTree/`), **2D typography FX** (`wordFx/`), and **routing** (`Visualizer.tsx`) from tangling, so each piece can be read or tweaked on its own.

Have fun!
