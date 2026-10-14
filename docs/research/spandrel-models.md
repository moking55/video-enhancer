# Research: pinned model set for the spandrel engine (Phase 1)

Date: 2026-10-14. Scope: choose and pin legally clean weights for new presets served by a spandrel runner, beside the shipped Real-ESRGAN presets. Builds on `docs/research/models.md`. Nothing in the app was changed.

Legend: **[V]** verified from a primary source (cited), **[M]** measured here (downloaded, hashed, loaded with spandrel, no inference), **[E]** estimate.

## 1. Method and environment

- Licence sources, in this order: the author's Hugging Face model card (`Phips/*`, YAML metadata and card text), the author's GitHub release body (`Phhofm/models`), the OpenModelDB entry (`OpenModelDB/open-model-database`, `data/models/*.json`). Accepted only when every source that states a licence says a permissive one (CC-BY-4.0, MIT, ...). Rejected: NC, SA, no stated licence.
- Files downloaded to a scratch dir, SHA-256 and byte size computed locally **[M]**. Every hash equals the Hugging Face LFS `sha256` (HF API `?blobs=true`) and, where OpenModelDB lists one, its `sha256` **[V]**.
- spandrel check: throwaway venv, **Python 3.11.0**, `spandrel 0.4.2` + `torch 2.14.1+cpu`, `numpy 2.4.6`, `einops 0.8.2`, `safetensors 0.8.0`. `ModelLoader().load_from_file(path)` only; **no inference was run** **[M]**. Venv and files deleted afterwards.
- Install note **[M]**: `pip install spandrel` works on Python 3.11 with no problems. The first attempt failed only because the venv's bundled pip 22.3 could not build `flit_core` when `--index-url` pointed at the PyTorch CPU index (spandrel's build backend needs `flit_core>=3.11`). Fix: upgrade pip, then use `--extra-index-url` for torch. Not a spandrel problem; the Colab install should do `pip install -U pip` first or install spandrel from the default index.
- Pin by Hugging Face **commit hash** in the URL (`/resolve/<commit>/<file>`), not `main`, so the bytes cannot change under the pinned SHA-256.

## 2. Accepted models

All loaded in spandrel 0.4.2 without error. `tiling` is `SUPPORTED` for all (spandrel has no tiler; the worker must tile itself). `size_requirements` is `minimum=0, multiple_of=1, square=False` unless noted, so no padding constraint.

| Slot | Model | Arch (spandrel `architecture.name`) | Scale | Params | supports_half | supports_bfloat16 | size_requirements | Licence (weights) | Author / date |
|---|---|---|---|---|---|---|---|---|---|
| 1. Fast 2x general | **2xNomosUni_span_multijpg** | SPAN | 2 | 2,221,140 | yes | yes | min 0, multiple 1 | CC-BY-4.0 | Philip Hofmann (Phhofm/Phips), 2023-12-13 |
| 1b. alt, fastest 2x general | 2xNomosUni_compact_multijpg | RealESRGAN Compact | 2 | 600,652 | yes | yes | min 0, multiple 1 | CC-BY-4.0 | Philip Hofmann, 2023-12 (HF repo created 2024-10-09; release 2024-04-15) |
| 2. Fast 2x anime | **2xHFA2kAVCCompact** | RealESRGAN Compact | 2 | 600,652 | yes | yes | min 0, multiple 1 | CC-BY-4.0 | Philip Hofmann, 2023-06-18 |
| 2b. alt anime | 2xHFA2kCompact | RealESRGAN Compact | 2 | 600,652 | yes | yes | min 0, multiple 1 | CC-BY-4.0 | Philip Hofmann, 2023-04-18 |
| 2c. optional anime (MIT) | 2x_ModernSpanimationV1 | SPAN | 2 | 3,940,452 | yes | yes | min 0, multiple 1 | MIT (OpenModelDB + release body) | TNTwise, 2024-04-06 |
| 3. Balanced 4x general (fast) | **4xNomosUni_span_multijpg** | SPAN | 4 | 2,236,728 | yes | yes | min 0, multiple 1 | CC-BY-4.0 | Philip Hofmann, 2023-12-09 |
| 3b. 4x general, noisy/compressed input | 4xNomos8k_span_otf_medium | SPAN | 4 | 2,236,728 | yes | yes | min 0, multiple 1 | CC-BY-4.0 (OpenModelDB) | Philip Hofmann, 2023-12-09 |
| 3c. 4x quality tier (fp32 only) | **4xNomosWebPhoto_RealPLKSR** | PLKSR (RealPLKSR variant) | 4 | 7,389,680 | **no** | yes | min 0, multiple 1 | CC-BY-4.0 | Philip Hofmann, 2024-05-28 |
| 3d. 4x quality tier (fp32 only) | 4xNomos2_realplksr_dysample | PLKSR (RealPLKSR + DySample) | 4 | 7,402,243 | **no** | yes | min 0, multiple 1 | CC-BY-4.0 | Philip Hofmann, 2024-06-30 |

Bold = recommended for the first presets. Important finding **[M]**: spandrel reports `supports_half = False` for both RealPLKSR models. T4 has no fast bf16, so these run fp32 on T4. That is much slower than the fp16 estimate in `docs/research/models.md` (which assumed fp16 for RealPLKSR). Re-measure before setting `secPerMegapixelFrame`; SPAN and Compact models are fine in fp16 (`supports_half = True`).

### 2.1 Download, hash, size (for `WeightSpec`)

Hosts: `HF` = `https://huggingface.co/Phips/<repo>/resolve/<commit>/<file>`. Hugging Face `.safetensors` are the author's own conversions of the original `.pth` (stored in fp32 on load; file sizes of the SPAN safetensors are about half the `.pth`, which is the author's fp16 storage; spandrel loads them as fp32 parameters **[M]**).

| Model | Filename | URL | SHA-256 | Bytes |
|---|---|---|---|---|
| 2xNomosUni_span_multijpg | `2xNomosUni_span_multijpg.safetensors` | https://huggingface.co/Phips/2xNomosUni_span_multijpg/resolve/ed6111c4cabdaf42b75e6535600d5370cce9e4e2/2xNomosUni_span_multijpg.safetensors | `bee2a9c082f2b8f6e7f5db504b36593c24a1a959511f587114c399ca58b9c92c` | 4461056 |
| 2xNomosUni_compact_multijpg | `2xNomosUni_compact_multijpg.safetensors` | https://huggingface.co/Phips/2xNomosUni_compact_multijpg/resolve/4774921957bcbd222e7e4861728b02ebb3502c31/2xNomosUni_compact_multijpg.safetensors | `ea51bc7aa05c801e42c85aa84007b8bb1dcd3f11d85d5979b26b29e4c8610401` | 1205456 |
| 2xHFA2kAVCCompact | `2xHFA2kAVCCompact.safetensors` | https://huggingface.co/Phips/2xHFA2kAVCCompact/resolve/8ba07f8c6953e05cc88e75bdebd34c581f191925/2xHFA2kAVCCompact.safetensors | `2a4bedce982752395a16e5fd29961d62783385018158e5db9e63864077a5973e` | 1205456 |
| 2xHFA2kCompact | `2xHFA2kCompact.safetensors` | https://huggingface.co/Phips/2xHFA2kCompact/resolve/09a1cc48be61cbb4a97d82ae440ad2fa06cb4a5c/2xHFA2kCompact.safetensors | `c20226f86e4f2a0c601e56776cce537336dcbb95c633bca011e801553e3833ff` | 1205456 |
| 2x_ModernSpanimationV1 | `2x_ModernSpanimationV1.pth` | https://github.com/TNTwise/Models/releases/download/2x_ModernSpanimationV1/2x_ModernSpanimationV1.pth | `bc6ca08ab1eeb9884a5c43c025eda97a5aa9ccfaa567734f426aedf55cf78327` | 15830922 |
| 4xNomosUni_span_multijpg | `4xNomosUni_span_multijpg.safetensors` | https://huggingface.co/Phips/4xNomosUni_span_multijpg/resolve/eb7c9845fb088203dcc9b5d94735c2a5f6b6213a/4xNomosUni_span_multijpg.safetensors | `3bedff643a1ba51b12e0174ebca62649a930ae3e7b0868be9706d8659d4d32a2` | 4492232 |
| 4xNomos8k_span_otf_medium | `4xNomos8k_span_otf_medium.pth` | https://github.com/TNTwise/real-video-enhancer-models/releases/download/models/4xNomos8k_span_otf_medium.pth | `c1a4395b6d34ffa86b1c6e8a443d32ccaba7a53fabf600f7c17d804cc8156b46` | 9015866 |
| 4xNomosWebPhoto_RealPLKSR | `4xNomosWebPhoto_RealPLKSR.safetensors` | https://huggingface.co/Phips/4xNomosWebPhoto_RealPLKSR/resolve/49d5da19489e645e870eb076ea84815471f27ef4/4xNomosWebPhoto_RealPLKSR.safetensors | `9be0228f98156a100d6636d99b373ed2785b999723f9adc4cca504329ab157f2` | 29590440 |
| 4xNomos2_realplksr_dysample | `4xNomos2_realplksr_dysample.safetensors` | https://huggingface.co/Phips/4xNomos2_realplksr_dysample/resolve/893bd79c7eccc29cc04fa0ac4ff08f72585c2605/4xNomos2_realplksr_dysample.safetensors | `371c210e419fb9a4c3f7bf1b9a94dfae0e344232a81147d4c9f9c96b44b5702a` | 29641748 |

Source caveats:
- `4xNomos8k_span_otf_medium.pth` is a third-party mirror (REAL-Video-Enhancer's model repo, maintainer TNTwise). The author's own links are Google Drive only. Integrity is guaranteed by the SHA-256, which equals the `sha256` OpenModelDB lists for the author's file. The mirror repo has no licence file; the CC-BY-4.0 claim rests on the OpenModelDB entry. If a stable author-hosted file is required, drop this model (3b) and keep 3.
- `2x_ModernSpanimationV1.pth` is on the author's GitHub release (`TNTwise/Models`); the release body says "License: MIT". The repo has no licence file. Input type is "images", trained on 2,200 modern-animation frames. Optional; skip if you want only models with an HF card.
- Prefer `.safetensors` where available (no pickle). The two `.pth` files are loaded by spandrel through `torch.load` (spandrel uses `weights_only=True` internally for `.pth` as far as I know **[E]**, not verified here); pin and verify SHA-256 before loading, which `ensure_weights` already does.

### 2.2 Training notes

| Model | Training data and degradations | Fit for real (compressed) video |
|---|---|---|
| 2xNomosUni_span_multijpg | Dataset "nomosuni" (2,989 images, HR patch 512). JPEG compression down to quality 40 plus multiscale down-up resizing (bicubic, bilinear, box, nearest, Lanczos). Not OTF. 37k iterations from `2x_span_anime_pretrain`. Author calls it a "fast universal 2x upscaler" **[V HF card]** | Good: handles JPEG-like blocking. No explicit video-codec or noise degradation, so heavy noise stays |
| 2xNomosUni_compact_multijpg | Same dataset/degradations as the SPAN sibling, Compact arch **[V OpenModelDB name/tags, HF repo]** | Same, smaller and faster |
| 2xHFA2kAVCCompact | HFA2k_h264: 2,568 frames from modern anime films; **H.264 (AVC) CRF 20-28** plus bicubic/bilinear/box/Lanczos down-scaling via Kim's dataset destroyer; 111k iterations, no pretrain, not OTF **[V HF card]** | Best anime fit: the only candidate trained on an actual video codec |
| 2xHFA2kCompact | HFA2k dataset (musl), **OTF compression and blur** **[V HF card]** | Good anime fit, generic compression/blur |
| 2x_ModernSpanimationV1 | Modern Animation V2 (2,200 images); compression, blur and un-sharpening degradations; 100k iterations; not OTF **[V release body / OpenModelDB]** | Anime, modern 1080p-style sources |
| 4xNomosUni_span_multijpg | nomosuni 2,989 images; JPEG down to q40 + multiscale (same recipe as 2x); 57k iterations from `spanx4_ch48`; not OTF **[V HF card]** | Good for mild compression; fast |
| 4xNomos8k_span_otf_medium | Nomos8k; OTF (on-the-fly) degradations, "strong" trained 90k iterations then "medium"/"weak" toned down; GT 512, batch 9; discriminator resets to avoid colour loss; "mainly meant for photos" **[V OpenModelDB description]** | Good for noisy/compressed input (OTF), may be over-smoothing |
| 4xNomosWebPhoto_RealPLKSR | Nomos-v2 (6,000 images), 12 mixed degraded LR sets: down-scaling + JPEG/WebP re-compression (Kim's dataset destroyer), **realistic noise** (ludvae200), lens blur (umzi's destroyer); degradation reduced vs. earlier RealWebPhoto models; 404k and 445k-iteration checkpoints interpolated **[V HF card]** | Best generic degradation coverage; heaviest, fp32 only |
| 4xNomos2_realplksr_dysample | Nomos-v2 (6,000 images); JPEG down to q70 only; **no OTF augmentation**; 185k iterations; card warns about colour oversaturation and suggests a wavelet colour fix **[V HF card, via research doc]** | Cleaner inputs only; needs spandrel >= 0.4.0 (DySample) |

Residual risks to note:
- All training datasets (nomosuni, Nomos8k/v2, HFA2k) are author-curated image sets; the model cards declare CC-BY-4.0 for the weights, but I did not audit the datasets' own upstream licences. Weights are a derived artefact and the declared licence is the only usable signal.
- The Phhofm GitHub repo has no licence file and no `license` field **[V]**; the licence lives on each HF card / release body / OpenModelDB entry.
- The `4xNomosWebPhoto_RealPLKSR` and `4xNomos2_realplksr_dysample` GitHub release bodies print "License: CC-BY-0.4", an evident typo. The HF YAML metadata and OpenModelDB both say CC-BY-4.0 for both **[V]**. Treat as CC-BY-4.0; if you want zero ambiguity, use 3 / 3b instead.

## 3. Rejected or deferred candidates

| Candidate | Source | Reason |
|---|---|---|
| 4x-SPANkendata (Crustaceous D) | OpenModelDB | **CC-BY-SA-4.0** (share-alike); also only an ONNX is listed on OpenModelDB, intended as a pretrain for undegraded photos |
| 4x-PurePhoto-span | OpenModelDB | CC-BY-SA-4.0 |
| 2x-OpenProteus (SiroSky) | `Sirosky/Upscale-Hub` | The repo `LICENSE.md` is **CC-BY-NC-4.0** [V]; the release page itself states no licence |
| 2x-AniSD suite (SiroSky) | OpenModelDB + `Upscale-Hub` | **CC-BY-NC-4.0** |
| 2x-AnimeJaNai (V2, V3, HD, Strong, Standard) (the-database) | OpenModelDB | **CC-BY-NC-SA-4.0** |
| 2x-LiveActionV1-SPAN (jcj83429) | OpenModelDB | **CC-BY-NC-SA-4.0** (otherwise ideal: trained on MPEG-4/H.264/VP9/H.265 + chroma subsampling) |
| 4x-UltraSharp (Kim2091) | OpenModelDB (research doc) | CC-BY-NC-SA-4.0 |
| Real-CUGAN official weights (bilibili/ailab) | repo + releases | Repo `LICENSE` is MIT but covers the software; the weights ship as zips on a GitHub release and netdisk links with **no stated weights licence** [V]. Not "clearly permissive" |
| 2xHFA2kReal-CUGAN (Phhofm) | HF card CC-BY-4.0 | **Deferred.** Declared CC-BY-4.0 (SHA-256 `d89f667697409024b085f327d74e8d52e56950997d53c1ccd09c55b89dd57c71`, 2574708 bytes, commit `df1a5bca436e760ad4ffd13d4fba6ee181555bc8`, loads in spandrel as `RealCUGAN`, 2x, 1,284,598 params, half yes, **`size_requirements minimum=32`**) but initialised from the official `up2x-latest-conservative` weights whose licence is unstated, so the CC-BY grant may exceed what the author could give. Slot 4 left empty unless the leader accepts that provenance risk |
| AnimeSR (TencentARC) | research doc | Code Apache-2.0, weights licence not stated; BasicSR-based; not a spandrel arch |
| 2xHFA2kSPAN / 2xHFA2k_LUDVAE_* / 2xNomosUni_span_multijpg_ldl | HF cards CC-BY-4.0 | Not rejected on licence; left out to keep the set small (siblings of accepted models; HFA2kSPAN is 8.9 MB SPAN anime, usable as an upgrade for slot 2 without new licence review) |
| Heavy transformers (DAT2, HAT, ATD, DRCT, 4xRealWebPhoto_v4_dat2) | research doc | Too slow for the 30-min T4 budget on video |

## 4. Recommendation for presets

| Slot | Pick | Why |
|---|---|---|
| Fast 2x general | `2xNomosUni_span_multijpg` (alt: `2xNomosUni_compact_multijpg` for max speed) | CC-BY-4.0, JPEG-tolerant, fp16-safe, 4.5 MB |
| Fast 2x anime | `2xHFA2kAVCCompact` (alt: `2xHFA2kCompact`) | Only candidate trained with H.264 degradation; 1.2 MB, 0.6M params |
| Balanced 4x general | `4xNomosUni_span_multijpg`; optional `4xNomos8k_span_otf_medium` for noisy clips | SPAN is fp16-safe; both CC-BY-4.0 |
| Quality 4x (optional, slower) | `4xNomosWebPhoto_RealPLKSR` over `4xNomos2_realplksr_dysample` | Trained with noise + codec-like degradations; dysample model targets clean input and oversaturates colour. **fp32 only per spandrel**, so re-measure speed |
| Real-CUGAN 2x anime | none for now | No clearly permissive weights (see section 3) |

Things the integration must handle **[E]**: no built-in tiler (write overlap tiling); `supports_half` per model (RealPLKSR: use fp32 and expect T4 fp32 speed); `size_requirements` (Real-CUGAN needs minimum 32 px); new `secPerMegapixelFrame` coefficients must be measured on T4 before enabling.

## 5. Attribution text (CC-BY-4.0), for the app

CC-BY-4.0 requires: credit the creator, link the licence, indicate whether changes were made, and not imply endorsement. The weights are used as published (the author's own HF conversions, no fine-tuning by us). Show a "Model credits" section listing only the models that have presets, for example:

> **Model credits.** Upscaling models are used under the Creative Commons Attribution 4.0 International licence (https://creativecommons.org/licenses/by/4.0/). No changes were made to the model weights by this app.
>
> - 2xNomosUni_span_multijpg, 4xNomosUni_span_multijpg, 4xNomos8k_span_otf_medium, 2xNomosUni_compact_multijpg, 2xHFA2kCompact, 2xHFA2kAVCCompact, 4xNomosWebPhoto_RealPLKSR, 4xNomos2_realplksr_dysample by Philip Hofmann (Phhofm / Phips). https://huggingface.co/Phips , https://github.com/Phhofm/models . Licence: CC BY 4.0.
> - 2xHFA2k models are trained on the HFA2k dataset by musl; the SPAN architecture is by Cheng Wan et al. (https://github.com/hongyuanyu/SPAN, Apache-2.0); RealPLKSR/PLKSR by Dongyoung Kong et al.; Real-ESRGAN Compact (SRVGGNetCompact) by Xintao Wang et al. (BSD-3-Clause); models run through spandrel by chaiNNer-org (MIT).
> - 2x_ModernSpanimationV1 by TNTwise, MIT licence (https://github.com/TNTwise/Models), include the MIT copyright notice if shipped.
>
> The authors do not endorse this app.

(The architecture/dataset credits in the second bullet are courtesy lines taken from the cited cards and research doc; the SPAN authors' names are from memory **[E]**, verify before publishing, or shorten to "SPAN (hongyuanyu/SPAN)".)

## 6. Sources

- Hugging Face cards and API (fetched 2026-10-14): https://huggingface.co/Phips/2xNomosUni_span_multijpg , `/2xNomosUni_compact_multijpg`, `/2xHFA2kAVCCompact`, `/2xHFA2kCompact`, `/2xHFA2kReal-CUGAN`, `/4xNomosUni_span_multijpg`, `/4xNomosWebPhoto_RealPLKSR`, `/4xNomos2_realplksr_dysample`; `https://huggingface.co/api/models/Phips/<repo>?blobs=true` for file sizes, LFS SHA-256 and commit hashes.
- Author GitHub releases: https://github.com/Phhofm/models/releases (repo `pushed_at` 2025-11-14, no licence file).
- OpenModelDB data: https://github.com/OpenModelDB/open-model-database/tree/main/data/models (`2x-NomosUni-span-multijpg`, `2x-HFA2kAVCCompact`, `2x-HFA2kCompact`, `4x-NomosUni-span-multijpg`, `4x-Nomos8k-span-otf-medium`, `4x-NomosWebPhoto-RealPLKSR`, `4x-Nomos2-realplksr-dysample`, `2x-ModernSpanimationV1`, `4x-SPANkendata`, `4x-PurePhoto-span`, `2x-AniSD-Suite`, `2x-AnimeJaNai-*`, `2x-LiveActionV1-SPAN`, `2x-HFA2Real-CUGAN`).
- TNTwise: https://github.com/TNTwise/Models/releases/tag/2x_ModernSpanimationV1 , https://github.com/TNTwise/real-video-enhancer-models/releases/tag/models ; REAL-Video-Enhancer model list: https://github.com/TNTwise/REAL-Video-Enhancer
- Sirosky: https://github.com/Sirosky/Upscale-Hub (`LICENSE.md` CC-BY-NC-4.0), https://github.com/Sirosky/Upscale-Hub/releases/tag/OpenProteus
- Real-CUGAN: https://github.com/bilibili/ailab/tree/main/Real-CUGAN (MIT software licence, weights licence unstated)
- spandrel 0.4.2: https://github.com/chaiNNer-org/spandrel
