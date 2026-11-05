# Auvra Creative Studio V2 — Remotion upgrade

## Scope and baseline

Source checked against `Blockboiy/Auvra`, branch `feat/creative-studio-remotion`, commit `7331f10971c1cd060fffd2274c53b225cbb60ba3` (2026-09-24).

Adds a Remotion React composition, server-side H.264 renderer, 1080x1920/1920x1080 at 30 FPS, three scenes / up to six image shots, safer staging, MP4 metadata checks and a smoke-test. Source image preservation is improved; original FFmpeg renderer remains as a non-destructive fallback. No paid video generation or synthesized voiceover.

**This upgrade is not live.** The source package is prepared, but a real MP4 run in the target project still must pass after dependencies are installed. Do not turn on the Remotion flag in Railway before that verification.

## Safe installation (no Codex account/credit needed)

1. Extract this ZIP **outside the Auvra checkout** (for example, into Downloads). Do not drag-copy individual files into the repository.
2. In Git Bash or another terminal, `cd` to your existing Auvra repository on `feat/creative-studio-remotion`.
3. Run `python "/path/to/auvra-remotion-upgrade/scripts/apply-upgrade.py" --check` (on Windows use your actual path to the extracted folder). This checks the branch and hashes of files to be modified; it never overwrites local changes.
4. If the check succeeds, run the same command without `--check`. Originals are retained in `.auvra-remotion-originals/`.
5. Run `corepack pnpm install` to regenerate `pnpm-lock.yaml`. The new dependencies cannot be used with the old frozen lockfile.
6. Run `corepack pnpm build`, `corepack pnpm typecheck`, `corepack pnpm lint`, and `corepack pnpm test`.
7. Run `node "/path/to/auvra-remotion-upgrade/scripts/smoke-render.mjs"`. It creates `auvra-remotion-smoke.mp4` in the repo root without using Orbio.
8. View the MP4, verify that the text stays sharp, and inspect `git diff` and `git status --short` before selecting files to commit. **Do not commit unrelated files.**

Run with `AUVRA_CREATIVE_RENDERER=remotion` to use the new engine; without this flag the existing FFmpeg renderer is used. Keep `AUVRA_CREATIVE_ENABLED=true` and your existing account/session configuration as before.

For example in Git Bash: `AUVRA_CREATIVE_RENDERER=remotion corepack pnpm --filter @auvra/api dev` (after the build).

## Deployment considerations

The included Dockerfile change adds Debian Chromium and sets `REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium` so the server need not download a browser at runtime. This changes image size and resource requirements. Rendering 450/900 frames at 1080p can be expensive on small Railway instances; the renderer limits concurrency to 1 and cancels after 12 minutes, but larger instances or a dedicated worker may be needed.

`AUVRA_CREATIVE_RENDERER=remotion` must be set explicitly after the smoke test. Use an adequately provisioned instance and persistent `AUVRA_CREATIVE_DIR` if projects must survive deployments. Old projects stay readable.

## Security and cost

Only generated `product1...product6` image names are copied into the isolated temporary public directory. The renderer never calls Orbio; inference costs remain unchanged. Rendering uses local compute and disk, which are not metered in the application's `renderCostUsd: 0` field. The protected demo remains shared-password access; uploaded images are not per-user isolated.

## Source status

The implementation package is prepared against the verified branch, but this isolated environment lacks network access to install the Remotion/npm dependencies and cannot access the GitHub account with push permissions. Therefore full workspace tests and real Remotion MP4 output are **not claimed** here. The installer is syntax-tested and tested against representative baseline fixtures; full runtime validation is required before deployment.

Docs: https://www.remotion.dev/docs/renderer/render-media and https://www.remotion.dev/docs/bundle
