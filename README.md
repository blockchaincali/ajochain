# Auvra Motion V4 — 30-second visual proof

This is a **standalone Remotion motion-graphics proof**, not a production Creative Studio upgrade or an autonomous video-generating agent yet. It adds four files; it does **not** replace `composition.tsx`, `renderer.ts`, your API routes, or the V3 sample. There are no Orbio/API calls and no cost to any inference allowance. Real rendering uses local CPU, RAM and storage.

## What it shows

- **00–05 / The problem:** three overlapping model windows and progressively revealed copy converge toward a single workspace.
- **05–09 / One mission:** model chips move into the real Auvra monogram, surrounded by an animated orbit.
- **09–15 / Multi-model workflow:** moving signals travel along distinct connectors; each named node has a visual role.
- **15–20 / Guardrails:** a budget dial and three illustrated controls appear one at a time (illustrative UI; not actual account settings).
- **20–26 / Execution:** a growing vertical path connects planning, executing and verifying, with synchronized check states.
- **26–30 / Brand close:** logo, staggered typography, final message and website.

The preview includes an **original procedurally synthesized ambient music bed and transition cues**, not speech. It does not claim the video contains recorded narration or new AI footage. The code uses the existing Remotion packages already installed in your Auvra checkout.

## Installation — Git Bash (no Python or Codex)

Download `auvra-motion-v4.zip` to `~/Downloads` and enter these commands **one at a time**:

```bash
cd ~/Downloads
unzip -o auvra-motion-v4.zip -d ~/Downloads
cd ~/projects/Auvra
node ~/Downloads/auvra-motion-v4/tools/apply-v4.mjs --check
```

Only if the last command says `DRY RUN PASSED`, run:

```bash
node ~/Downloads/auvra-motion-v4/tools/apply-v4.mjs --apply
corepack pnpm --filter @auvra/api build
```

For the **first preview**, use the small-format output. The script logs bundle/browser/render/verification stages and percentage updates so it no longer looks frozen:

```bash
node scripts/v4-preview.mjs --preview
explorer.exe auvra-motion-v4-preview.mp4
```

After visually approving that preview, an optional full-size 1080×1920 render is:

```bash
node scripts/v4-preview.mjs --full
explorer.exe auvra-motion-v4-full.mp4
```

The full render is 900 frames at 1080×1920, so allow substantial rendering time. First run may need Chromium download; subsequent runs reuse the installed browser. An optional silent preview is `node scripts/v4-preview.mjs --preview --silent`.

Run workspace checks separately as usual:

```bash
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
```

## Configurable creative copy

Edit `scripts/v4-plan.json` after installation to change the brief-supported copy. The preview script validates basic field types and lengths. The six **visual treatments remain Auvra-specific**; changing copy does not make it an autonomous AI art director. That is a separate future implementation.

## Audio and verification

The render script generates a local 30s WAV in a temporary asset directory and the Remotion composition includes it through `<Audio>`. Rendering is not muted by default. The script verifies MP4 dimensions, frame rate, codec, duration and minimum file size; visual judgment still requires watching the output. If you have ffprobe, audio can be independently checked with:

```bash
ffprobe -v error -show_entries stream=codec_type,codec_name -of default=noprint_wrappers=1 auvra-motion-v4-preview.mp4
```

A successful result should include video and audio streams unless `--silent` was selected.

## Safety and rollback

The installer requires `feat/creative-studio-remotion`, verifies V3 is present, refuses to overwrite any of its four destination files, and leaves all unrelated tracked/untracked changes alone. Output MP4s stay untracked; don't run `git add .`. If needed, `node ~/Downloads/auvra-motion-v4/tools/apply-v4.mjs --remove` deletes only the four V4 proof files **if none of them have been edited**. It never deletes existing V3 files.

## Status / limits

The source was syntax/transpilation checked and the installer was exercised against a test repository. An end-to-end Remotion MP4 cannot be rendered in the packaging environment because it cannot access npm to install Remotion dependencies. The actual video, appearance, and audio must be confirmed in your Windows Auvra checkout. Do **not** push, merge, set a Railway environment variable or claim live integration based on this proof alone.
