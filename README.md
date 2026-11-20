# voice-commerce

TypeScript monorepo for a voice-driven commerce SDK with a Phaser 3 game example.

## Structure

| Package | Description |
|---|---|
| `packages/core` | Provider-agnostic interfaces (GameItem, WalletAdapter, PurchaseAdapter, VoiceProviderAdapter) |
| `packages/adapter-agora` | Placeholder Agora voice adapter (no SDK yet) |
| `examples/voicestrike` | Vite + Phaser 3 browser game |

## Prerequisites

- Node.js 20+
- npm 10+

## Setup

```bash
npm install
```

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start Vite dev server for voicestrike |
| `npm run build` | Build all packages |
| `npm run typecheck` | Type-check all packages |
