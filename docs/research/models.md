# Research: SR / restoration models for Colab free (T4)

Date: 2026-10-14. Researcher: worker agent (web research only; nothing installed or run).
Scope: candidates to add beside Real-ESRGAN x2plus / x4plus / animevideov3 / general-x4v3 (shipped) and the SeedVR2 3B spike (planned).
Target environment: Colab free T4 15 GB, fp16 only (no native bf16/fp8), ~12 GB RAM, 2 vCPU, Python 3.13, torch 2.x, frame-wise ffmpeg pipeline, ~30 min GPU per job.

Legend. **[V]** = verified from the cited source (URL in section 9). **[E]** = my estimate or inference, not measured. "n/s" = not stated by source. Dates are the GitHub `pushed_at` from `api.github.com` unless noted.

---

## 1. Ranked recommendation (summary)

| Rank | Addition | Tier | Why | Effort |
|---|---|---|---|---|
| 1 | **spandrel as a second engine** (`runners/spandrel.py`) loading `.pth/.safetensors` from a pinned allowlist of models | infrastructure | One MIT, pure-PyTorch loader covers Compact, RRDB/ESRGAN, SPAN, RealPLKSR, DAT, HAT, SwinIR, Real-CUGAN, APISR, MoSR, ... and removes the `basicsr`/`realesrgan` install workarounds for new presets. Python >=3.10, release 0.4.2 on 2026-02-21 **[V]**. | M |
| 2 | **Fast general 2x: `2xNomosUni_span_multijpg`** (SPAN, CC-BY-4.0) and **fast anime 2x: `2xHFA2kCompact`** (SRVGGNetCompact, 0.6M params, CC-BY-4.0) | fast | Fills the missing "fast native 2x" slot; Compact/SPAN are the fastest archs in the only cross-arch benchmark found (26 / 21 fps vs ESRGAN 2.2 fps, hardware unspecified) **[V]**. | S after #1 |
| 3 | **Quality 4x photo: `4xNomos2_realplksr_dysample`** (RealPLKSR + DySample, CC-BY-4.0) | balanced | About 2.3x faster than ESRGAN/RRDB in the same benchmark (5.05 vs 2.22 fps) **[V]** so roughly 2.5-3.6 s per input megapixel on T4 **[E]**, i.e. cheaper than x4plus (5.69 measured) and a different look. Needs spandrel >= 0.4.0 (DySample) **[V]**. | S after #1 |
| 4 | **Real-CUGAN (2x/3x/4x, conservative/denoise variants)** for anime | anime | MIT code; official CUNet weights load via spandrel; denoise strength choice is a real feature that Real-ESRGAN anime lacks. Weights licence not stated (see risks). Effort S after #1. | S |
| 5 | **Spike (not ship): MoTSR 2x recurrent video SR** (MIT code+weights) | video-native | Only candidate found that is temporal, 2x, tested on a T4 on Python 3.13 / torch 2.11 by its author **[V]**. But created 2026-10-06, 3 stars, "results aren't perfect" **[V]**. Time-box a one-clip spike. | M-L |
| (planned) | SeedVR2 3B spike | highest quality | Apache-2.0 code and weights **[V]**; fp16 3B = 6.78 GB, fp8 = 3.39 GB **[V]**; one 8 GB-GPU report of ~35 s/frame for 480x360 -> 960x720 **[V]**. See section 4. | L |

**Avoid** (reasons in the tables): FlashVSR (needs Block-Sparse-Attention built for Ampere+, Python 3.11), DOVE, STAR, VEnhancer, Upscale-A-Video (24-80 GB class, some non-commercial), RealBasicVSR and BasicVSR++ (mmcv-full / mmedit, last commits 2023), RealViformer (unfinished repo), CodeFormer (S-Lab non-commercial), APISR as a shipped dependency (GPL-3.0, "academic use only" wording), 4x-UltraSharp unless you accept CC-BY-NC-SA, NanoVSR (bicubic-trained, edge-device paper), heavy transformers (DAT2, HAT-L, ATD, DRCT) as video presets.

Key caveats up front:
1. Everything frame-wise (all of ranks 1-4) will flicker the same way Real-ESRGAN does; none adds temporal consistency **[E]**. Only MoTSR and SeedVR2 are temporal, and both are risky.
2. Heavy transformer archs are 4-10x slower than RRDB in the one benchmark found, so on the 30-min budget they are image / keyframe tools only **[E from V benchmark]**.
3. spandrel has **no built-in tiler**: you must write overlap tiling yourself (it exposes `size_requirements` and a `tiling` hint, and pads automatically) **[V]**.
4. Per-model licences vary (CC-BY-4.0 is common, 4x-UltraSharp is CC-BY-NC-SA-4.0). Pin an allowlist and record each model's licence in the preset definition.

---

## 2. Frame-wise SR via spandrel + OpenModelDB

### 2.1 spandrel

| Item | Finding |
|---|---|
| Licence (code) | MIT **[V]** |
| Licence (arch code inside) | Each architecture keeps its original licence in its `__arch/` dir. The core `spandrel` package ships only permissive/public-domain archs; non-commercial/copyleft archs are in the separate `spandrel_extra_arches` package **[V]** |
| Latest | spandrel 0.4.2, 2026-02-21, `requires_python >=3.10`, deps: torch, torchvision, safetensors, numpy, einops, typing_extensions **[V]**. Repo `pushed_at` 2026-04-12 (active; `updated_at` 2026-10-13) **[V]** |
| `spandrel_extra_arches` | 0.2.0, 2024-09-16, requires spandrel>=0.3.2 **[V]** (stale; only needed for CodeFormer/SRFormer/FeMaSR/Restormer etc.) |
| Image SR archs | ESRGAN (RRDBNet incl. Real-ESRGAN, RealSR, BSRGAN), Real-ESRGAN Compact (SRVGGNet), Swift-SRGAN, SwinIR, Swin2SR, HAT, Omni-SR, DAT, GRL, DITN, MM-RealSR, SPAN, Real-CUGAN, CRAFT, SAFMN, RGT, DCTLSA, ATD, AdaCode, DRCT, PLKSR/RealPLKSR, SeemoRe, MoSR, MoESR, RCAN, FDAT, AuraSR; extra-only: SRFormer, FeMaSR **[V]** |
| Restoration archs | GFPGAN, RestoreFormer, CodeFormer (extra), SCUNet, Uformer, KBNet, NAFNet, FFTformer, DnCNN/DRUNet, FBCNN (DeJPEG), DDColor (extra), RetinexFormer, HVI-CIDNet, LaMa, MAT (extra) **[V]** |
| Not supported | BasicVSR/BasicVSR++/RealBasicVSR/AnimeSR (video models), diffusion models, waifu2x (nunif) **[V by absence from list]** |
| File formats | `.pth`, TorchScript `.pt`, some `.ckpt`, `.safetensors` **[V]** |
| API | `ModelLoader().load_from_file(path)` returns `ImageModelDescriptor`; `.cuda().eval()`, `.half()`; `model(x)` takes `(1,C,H,W)` float in [0,1] on the model's dtype/device, returns clamped output, auto-pads to `size_requirements` **[V]**. Descriptor exposes `scale`, `supports_half`, `supports_bfloat16`, `tiling` (SUPPORTED / DISCOURAGED / INTERNAL), `architecture`, `purpose` ("SR"/"FaceSR"/"Restoration") **[V]** |
| Release notes of interest | v0.4.0 RealPLKSR DySample, MoSR; v0.4.1 MoESR, RCAN, RealPLKSR LayerNorm; v0.4.2 bf16 for DAT/HAT, FDAT, AuraSR; v0.3.1 APISR state-dict handling; v0.4.0 fixed a NumPy 2 incompat in tests **[V]** |
| Py 3.13 / torch 2.x | Pure Python wheel, no custom CUDA ops. No Python-3.13 statement in the release notes **[V]**; the PyPI floor of 3.10 with no upper cap suggests it installs on 3.13 **[E]**. The README badge "Python <3.12" is stale vs PyPI metadata **[V]** (conflict; test `pip install spandrel` in the Colab spike) |
| Integration effort | **M** (one new runner: load, fp16 where `supports_half`, own tiling with overlap/feather, pad handling, same decode/encode pipeline). Replaces `basicsr` patching for every spandrel-served preset **[E]** |

Notes for integration **[E]**:
- Keep the existing Real-ESRGAN runner for the four shipped presets (proven on T4). Add spandrel as an additional runner and migrate shipped presets later only if desired; spandrel can load `RealESRGAN_x2plus`, `x4plus`, `animevideov3`, `general-x4v3` too (all ESRGAN/SRVGG archs).
- Preserve the existing guard that detects swallowed CUDA OOM (spandrel call raises normally, so a plain `try/except torch.cuda.OutOfMemoryError` is enough).
- fp16 overflow is a known risk for some transformer archs; check `supports_half` and fall back to fp32 + smaller tile.
- Add a per-model SHA-256 pin like `weights.py` already does.

### 2.2 OpenModelDB model candidates

OpenModelDB lists 671 models with per-model licences ("Models carry their own licenses"); site code is GPL-3.0 **[V]**. Most Phhofm/Phips models are on Hugging Face (`Phips/...`) and mirrored on OpenModelDB.

Speed reference: the only cross-architecture benchmark found (Phhofm README; neosr test script, 50 images of 256x256, fastest of 3 runs, **hardware not stated**) **[V]**:

| Arch | fps | Relative to ESRGAN (RRDB, same table) |
|---|---|---|
| Compact | 26.35 | 11.9x faster |
| SPAN | 21.44 | 9.7x |
| SAFMN | 17.11 | 7.7x |
| PLKSR_tiny | 11.31 | 5.1x |
| Real-CUGAN (CUGAN) | 11.22 | 5.1x |
| OmniSR | 5.62 | 2.5x |
| RealPLKSR | 5.05 | 2.3x |
| SwinIR-S | 3.53 | 1.6x |
| ESRGAN (RRDB) | 2.22 | 1.0x |
| SwinIR-M | 1.08 | 0.49x |
| DRCT / DAT2 / DAT-S | 0.85 / 0.61 / 0.67 | 0.38x / 0.27x / 0.30x |
| HAT-S / HAT-M / HAT-L | 0.70 / 0.55 / 0.28 | 0.32x / 0.25x / 0.13x |
| ATD | 0.33 | 0.15x |

Using our measured `RealESRGAN_x4plus` = 5.69 s per input megapixel (T4, fp16) as the RRDB anchor and our measured Compact = 0.69 s/MP, my **estimates** for T4 coefficients **[E, scale the ratios above; fp16 behaviour of transformers on T4 may differ a lot]**:

| Arch | Est. s per input MP-frame on T4 | 640x360 s/frame | Fits 30 min on a 10 s 30 fps 360p clip (300 frames)? |
|---|---|---|---|
| SPAN | ~0.8-1.0 | ~0.2 | yes (~1 min) |
| Compact (num_conv 16) | 0.69 (measured for animevideov3) | 0.16 | yes |
| RealPLKSR | ~2.5-3.6 | ~0.6-0.8 | yes (~3-4 min) |
| ESRGAN RRDB (x4plus) | 5.69 (measured) | 1.31 | yes (~7 min) |
| DAT2 / HAT-S | ~20-25 | ~5 | no (~25 min, too tight) |
| HAT-L / ATD | ~40-60 | ~10-14 | no |

Candidate models (licence checked on the model card where noted):

| Model | Task | Arch | Scale | Licence (weights) | Verdict |
|---|---|---|---|---|---|
| 2xNomosUni_span_multijpg (Phhofm) | general fast, JPEG-tolerant | SPAN | 2x | CC-BY-4.0 **[V HF card]** | **Add** (fast 2x) |
| 2xHFA2kCompact (Phhofm) | anime | SRVGGNetCompact, 600,652 params, 4.6 MB | 2x | CC-BY-4.0 **[V]** | **Add** (fast anime 2x) |
| 2xHFA2kAVCCompact / 2xHFA2kSPAN | anime, AVC compression | Compact / SPAN | 2x | not individually checked (repo has no licence file; HF cards use CC-BY-4.0 for siblings) | Candidate |
| 4xLSDIRCompact(C/N/R) | photo | Compact | 4x | not individually checked | Candidate for fast 4x photo (animevideov3/general-x4v3 already cover similar ground) |
| 4xNomos2_realplksr_dysample | photo, depth-of-field kept, JPEG q>=70 | RealPLKSR + DySample | 4x | CC-BY-4.0 **[V HF card]** (card body typo "CC-BY-0.4") | **Add** (balanced 4x). Card warns it oversaturates colours; wavelet colour fix recommended **[V]** |
| 4xNomosWebPhoto_RealPLKSR | web photos | RealPLKSR | 4x | not individually checked | Candidate |
| 4xRealWebPhoto_v4_dat2 | web photos, compression/noise/blur | DAT2 | 4x | CC-BY-4.0 **[V HF card]** | Image/keyframe quality tier only; too slow for video **[E]** |
| 4xNomos8kSC | photo, JPEG | ESRGAN (64nf23nb) | 4x | CC-BY-4.0 **[V OpenModelDB]** | Same cost class as x4plus |
| 4x-UltraSharp (Kim2091) | general, JPEG removal | ESRGAN (64nf23nb) | 4x | **CC-BY-NC-SA-4.0** **[V OpenModelDB]** | Popular, but non-commercial + share-alike; personal use only, do not bundle in the public repo |
| 4xNomos2_hq_dat2 / drct-l / atd, 4xNomos8kSCHAT-L | clean input, max quality | DAT2 / DRCT-L / ATD / HAT-L | 4x | n/s individually | Not for video |

Maintenance: Phhofm/models repo last `pushed_at` 2025-11-14, last release 2025-10-14, ~111 models; repo has no licence field **[V]**. Models are static files, so maintenance is not a runtime risk.

---

## 3. Video-native / temporal models

| Model | Task | Scale | Arch / params | Licence (code / weights) | Temporal | Last push | T4 15 GB feasibility | CPU | Effort | Risks |
|---|---|---|---|---|---|---|---|---|---|---|
| **RealBasicVSR** | real-world VSR | 4x | BasicVSR++-based, 6.3M **[V paper table 2 of RealViformer]** | Apache-2.0 / weights not stated (Dropbox, Drive, OneDrive) **[V]** | video-native (bidirectional recurrent) | 2023-06-05 **[V]** | Small model, would fit **[E]**; repo pins torch 1.7.1/cu101, `mmcv-full` + `mmedit` unpinned **[V]** | no | L | mmcv-full has no wheels for torch 2.x / Py 3.13 **[E]**; would need a port. Avoid |
| **BasicVSR++** | bicubic-trained VSR | 4x | ~7M **[E: abstract says "similar number of parameters" as BasicVSR; 7.3M not verified]** | Apache-2.0 / n/s **[V]** | video-native | 2023-12-27 **[V]** | fits **[E]** | no | L | `mmcv-full` / MMEditing; uses deformable conv (custom op) **[E, from architecture knowledge; page does not say]**; trained on bicubic so poor on real footage **[E]** |
| **RealViformer** | real-world VSR (channel attention) | 4x (n/s on page) | 5.3M, 49 ms vs RealBasicVSR 73 ms **[V paper Table 2, GPU not named]** | MIT / weights on Google Drive **[V]** | video-native | 2024-07-22 **[V]** | would fit **[E]** | no | M-L | README has unfinished TODOs, 8 commits, Python >=3.9 / torch >1.12 so likely torch-2-friendly **[V]**; no scale/speed docs. Possible stretch spike |
| **AnimeSR** | anime VSR | native 4x, outscale resizes | n/s | Apache-2.0 (+ third-party BSD/MIT/HPND) **[V LICENSE]** / weights n/s | partial: processes video input, architecture not documented on page **[V]** | 2023-08-18 **[V]** | small (BasicSR based) **[E]** | no | M-L | needs BasicSR fork `setup.py develop`, Python >=3.7 / torch >=1.7 **[V]**; stale. Prefer Real-CUGAN / animevideov3 |
| **MoTSR** (new) | real-life video 2x, recurrent | 2x only | MoSRv2 body, 24 blocks + temporal fusion; model file 16.9 MB; params n/s **[V]** | MIT code, weights, notebook **[V]** | **yes**: 5 LR frames (t-2..t+2) + 2 prior SR outputs, scene-cut reset, offline with 2-frame look-ahead **[V]** | 2026-10-07; created 2026-10-06; 3 stars; 5 commits; release v1.0.0 **[V]** | **T4 15 GiB tested by the author, Python 3.13, torch 2.11+cu130, TensorRT 11**: 52 frames of 720p->1440p in 38-40 s (~1.3 fps, ~0.77 s/frame, ~0.83 s per input MP) with TRT + NVENC; PyTorch + libx264 path faster on a tiny 6-frame clip **[V self-reported validation.json]**. VRAM n/s | no (TRT/T4) | M-L (own recurrent loop + look-ahead buffer; safetensors + PyTorch path is available) | Brand-new and self-validated only; author says "results aren't perfect and will vary"; no PSNR/LPIPS **[V]**. Spike with 2 clips before any preset |
| **NanoVSR** (ECCV 2026) | efficient VSR | 4x | 226k / 644k / 1.7M / 5.4M **[V]** | MIT / weights on GitHub Releases v1.0 **[V]** | yes (implicit alignment) | released 2026-07 **[V]** | trivially fits; 27 fps at 180x320 on Jetson Orin NX FP16 for 644k **[V]** | plausible | M | **Trained on bicubic degradation only** **[V]** -> will not clean real compression noise; Python 3.13/torch 2.10 tested **[V]**. Avoid for user footage |
| **SeedVR2 3B** | one-step diffusion VSR / restoration | arbitrary (target res) | DiT 3B (7B also) | Apache-2.0 / Apache-2.0 **[V]** | video-native | wrapper v2.5.24 2025-12-24, `pushed_at` 2025-12-25 **[V]** | see section 4 | no | L | see section 4 |
| **FlashVSR v1.1** (CVPR 2026) | one-step streaming diffusion VSR | 4x | Wan2.1-based DiT + tiny conditional decoder; weights ~6.5 GB via community post **[V]** | Apache-2.0 / Apache-2.0 **[V]** | video-native streaming | 2026-09-01 **[V]** | **Not feasible as shipped**: Block-Sparse-Attention is a separate source build "works well on A100/A800", "H200 limited acceleration", other GPUs unknown; Python 3.11.13 specified **[V]**. Community ComfyUI forks add SDPA / sparse-sage paths; the "VRAM tiers" table lists 16 GB = `tiny` + tiled VAE, bf16/auto; Turing needs `triton<3.3.0` **[V]**. 17 fps on A100 at 768x1408 **[V]** | no | L | sm75 + fp16-only T4 is outside the tested set; likely needs a fp16 port **[E]**. Watch, do not build now |
| **DOVE** | one-step diffusion VSR | ~4x **[E]** | CogVideoX1.5-5B (also DOVE-2B on CogVideoX-2B) | Apache-2.0 / n/s **[V]** | video-native | 2026-05-20 **[V]** | no inference VRAM stated; 5B-class video DiT, offers tile/chunk options **[V]** -> will not fit 15 GB fp16 without heavy offload **[E]** | no | L | avoid |
| **STAR** | diffusion VSR | 4x | I2VGen-XL / CogVideoX-5B | MIT (I2VGen-XL based) and CogVideoX License (5B based) **[V]**; repo licence field null | video-native | 2025-07-02 **[V]** | README: 72 frames at 426x240 -> 4x needs ~39 GB with defaults, recommends >=24 GB **[V]** | no | L | avoid |
| **VEnhancer** | generative SR + interpolation | 1-8x | n/s | **no licence stated** **[V]** | video-native | 2024-09-16 **[V]** | "at least A100 80G" single GPU **[V]** | no | L | avoid |
| **Upscale-A-Video** | diffusion VSR | 4x | n/s | **NTU S-Lab License 1.0** (repo licence NOASSERTION) **[V]** | video-native | 2024-09-27 **[V]** | VRAM not stated; diffusion + temporal layers **[E: far above 15 GB]** | no | L | avoid (non-commercial licence family, stale) |

Notes:
- `karailker/restorax` (MIT, 4 stars) markets 25 models but its own status table lists FlashVSR, SeedVR, Upscale-A-Video, MambaIR as "GPU only, not implemented" and BasicVSR++ as "needs work" **[V]**. Not a shortcut.
- `LiteVSR` (arXiv 2606.09250, frozen-DiT adapter) has no code link **[V]**. Not usable.
- Community SeedVR2 porting activity (ncnn Vulkan CPU port `mingshi2333/seedvr2-ncnn-vulkan`, 2026-09-13) exists but is unvetted **[V listing only]**.

---

## 4. SeedVR2 on T4 (context for the planned spike)

Verified:
- Official repo `IceClear/SeedVR2`: Apache-2.0; accepted to ICLR 2026; weights on HF `ByteDance-Seed/SeedVR2-3B` licensed Apache-2.0; model card calls them "prototype models", notes weak robustness to heavy degradations / large motion and that light-degradation inputs (e.g. 720p AI video) may come out over-sharpened **[V]**.
- Wrapper `numz/ComfyUI-SeedVR2_VideoUpscaler` (Apache-2.0, v2.5.24 on 2025-12-24): FP16, FP8 (e4m3fn), GGUF Q4_K_M and Q8_0 for 3B; FP16 / FP8 / GGUF for 7B; BlockSwap (1-32 blocks for 3B, 1-36 for 7B); separate `encode_tiled` / `decode_tiled` VAE tiling (default tile 1024, overlap 128); standalone `inference_cli.py` with `--chunk_size` streaming and multi-GPU; Python 3.12 and 3.13 tested; needs PyTorch 2.0+ for compile; Flash-Attn 2 is Ampere+ and everything falls back to PyTorch SDPA; auto bf16 fallback probe, "RTX 20XX cards unaffected" **[V]**.
- Weight sizes (HF `numz/SeedVR2_comfyUI`): 3B fp16 6.78 GB, 3B fp8 3.39 GB, 7B fp16 16.5 GB, 7B fp8 8.24 GB, VAE 501 MB **[V]**. So **7B fp16 cannot fit 15 GB**; 3B fp16 can fit weights-wise.
- Wrapper guidance: 8 GB or less = GGUF Q4_K_M + BlockSwap + VAE tiling; 12-16 GB = FP8 with BlockSwap/tiling as needed **[V]**. (T4 has 15 GB, so the 12-16 GB tier applies.)
- One user report (RTX 5070 Laptop 8 GB, 3B GGUF Q8_0, block-by-block CPU offload, VAE tile 512): ~35 s/frame for a single 480x360 -> 960x720 frame; fp16 VAE gave dark patches (switched to bf16); output still softer than official demos **[V GitHub issue #54 on ByteDance-Seed/SeedVR]**.
- Another user hit VAE conv spatial splitting artifacts (visible lines in tiles) fixed by disabling that splitting **[V, same issue]**.

Estimates **[E]**:
- T4 has no bf16 tensor cores. If the VAE or DiT need bf16 to avoid fp16 overflow (dark patches report), the spike must test fp16 VAE overflow and a fp32 VAE (slower, 501 MB so cheap on VRAM).
- fp8 on T4 is storage only (weights upcast to fp16 for compute), so fp8 helps VRAM, not speed.
- If a T4 landed anywhere near the 35 s/frame figure, a 30-min budget fits ~50 frames at 720p-class output, i.e. ~2 s of 24 fps video. That matches the SPEC target ("a few seconds at ~480p"); no-go is plausible.
- 12 GB system RAM: block swapping offloads to CPU RAM; an issue on the wrapper reports a video-loading RAM spike (64 GB user) **[V issue #457 title only]**, so decode must stay streaming (chunked) rather than loading all frames.

---

## 5. Anime

| Model | Task | Scale | Arch / params | Licence (code / weights) | Temporal | Last push | T4 | CPU | Effort | Risks |
|---|---|---|---|---|---|---|---|---|---|---|
| **realesr-animevideov3** (shipped) | anime video | x4 (usable x1-x3) | SRVGGNetCompact "XS" | BSD-3-Clause repo / weights licence not stated on model zoo page **[V]** | frame-wise | 2024-08-06 **[V]** | 0.16 s/frame at 360p->1440p **[V, our spike]** | feasible | done | -- |
| **Real-CUGAN** (bilibili/ailab) | anime SR + denoise | 2x, 3x, 4x (1x "training") | CUNet (UNet cascade); `upcunet_v3.py` | **MIT** (LICENSE file begins "MIT License") **[V]** / weights licence not stated; hosted on GitHub Releases, Baidu, Drive **[V]** | frame-wise (repo has an `inference_video.py`) | repo `Real-CUGAN` last changelog 2022-08-09 **[V]** | ~1.5 GB VRAM for NVIDIA cards, "heavy" vs "light" versions, relative speed 2.2x faster than Real-ESRGAN Anime6B per README **[V]**; in the Phhofm table CUGAN is 11.22 fps vs Compact 26 **[V]** | feasible but slowish | **S** after spandrel (arch supported) **[V]** | 2x has 4+ denoise strengths (no-denoise / 1x / 2x / 3x), 3x/4x only no-denoise and 3x; "conservative" listed; 4x is the less-complete model **[V]**; stale repo but weights are static |
| **APISR** | anime image/video SR | 2x (RRDB), 4x (RRDB, GRL, DAT-small) | RRDB 6 blocks 4.47M (0.010 s / 0.035 s at 256x256 on 3090 Ti, fp32); GRL 1.03M (0.078 s); DAT-small 10.89M (0.683 s) **[V model_zoo.md]** | **GPL-3.0**; README says "released for academic use only" **[V]** / weights licence n/s | frame-wise; README states nothing about temporal consistency **[V]** | 2025-10-16 **[V]** | RRDB 2x/4x are cheap; spandrel loads APISR state dicts (v0.3.1) **[V]** | possible for 2x RRDB | S via spandrel | GPL + "academic only" wording; if you only load weights through spandrel the GPL code is not in your repo, but the weights' terms are unclear. Optional personal-use preset |
| **AnimeSR** | see section 3 | | | | | | | | | stale, Apache-2.0; skip |
| **waifu2x (nunif PyTorch)** | anime/photo denoise + 2x | 2x | PyTorch models in `nunif` (swin_unet / cunet; not confirmed on fetched pages) | MIT (code); warns distributed binaries may become GPL via PyAV; weights licence not stated **[V]** | frame-wise | `pushed_at` 2026-10-13 (very active) **[V]** | n/s | n/s | M (own framework, Python >=3.10, needs `requirements.txt`) | Not in spandrel; only worth it for photo denoise models. Legacy `nagadomi/waifu2x` is Torch7 and superseded **[V]**. Skip |

---

## 6. Face restoration (optional add-on; SPEC currently marks face restore out of scope)

| Model | Licence (code / weights) | Notes | Effort | Verdict |
|---|---|---|---|---|
| **GFPGAN** v1.3 / v1.4 | Apache-2.0 **[V README + PyPI]** / weights licence not stated **[V]** | PyPI `gfpgan` 1.3.8 (2022-09-16, no `requires_python`, pulls `basicsr>=1.4.2`, `facexlib`, `tb-nightly`) **[V]**; "Clean" arch (v1.2+) needs no custom CUDA ops **[V]**; repo last push 2024-07-26 (NOASSERTION in GitHub's detector) **[V]**. spandrel supports GFPGAN arch **[V]** so you could skip the pip package and bring only `facexlib` for detect/align **[E]** | M (face detect + align + paste-back, per frame; flicker risk) | If ever added, the safest choice |
| **CodeFormer** | **NTU S-Lab License 1.0: non-commercial only**; commercial use requires contacting the authors **[V LICENSE file]**; weights licence not separately stated **[V]** | Needs `basicsr` via `python basicsr/setup.py develop`, Python 3.8 example **[V]**; spandrel supports it only via `spandrel_extra_arches` (stale 0.2.0) **[V]** | M | **Avoid** (licence + friends use of a shared service raises "commercial-like" ambiguity; SPEC already notes service-like risk) |
| **RestoreFormer++** | Apache-2.0 / weights licence n/s **[V]** | Pins `pytorch-lightning==1.0.8`, `omegaconf==2.0.0`, `realesrgan==0.3.0`, `basicsr` 1.3.3.4 (upgrade to >=1.4.2) **[V]**; last updates 2024-01-22 / push 2024-09-01 **[V]** | L (dependency pins fight Py 3.13) | Avoid; spandrel's RestoreFormer arch is the only sane route |

Face caveat **[E]**: face models trained on FFHQ-style data; the dataset's own terms and the per-frame face-swap flicker are product risks independent of the code licence. Not verified here.

---

## 7. CPU-friendly options

| Option | Task / scale | Licence | CPU speed | Verdict |
|---|---|---|---|---|
| **OpenCV `dnn_superres`**: FSRCNN (~40 KB; FSRCNN-small ~9 KB), ESPCN (~100 KB), LapSRN (1-5 MB), EDSR (~38.5 MB) | SR, ESPCN x2/x3/x4, EDSR x2/x3/x4, LapSRN x2/x4/x8; FSRCNN scales not listed on contrib page but the Saafke repo ships x2/x3/x4 `.pb` **[V]** | OpenCV Apache-2.0 **[E: standard OpenCV licence, not fetched]**; FSRCNN weights repo Apache-2.0 **[V]** | OpenCV contrib page reports only an i7-9700K CPU timing table (numbers not retrieved) **[V]** | Tiny and dependency-light, but these are pre-GAN, T91/General100-trained models: smooth, no denoise/deblock. Quality below x4plus/Compact by a large margin **[E]**. Only a "last resort when no GPU" preset |
| **SRVGGNetCompact / SPAN on CPU (PyTorch fp32)** | e.g. `2xHFA2kCompact`, 0.6M params | CC-BY-4.0 weights | **[E]**: ~0.6M MACs per input pixel x 230k px (360p) ~ 0.14 TMAC per frame; with 2 vCPU at maybe 30-60 GFLOPS effective -> roughly 3-10 s/frame at 640x360 (our SPEC's 15-30x of GPU 0.16 s = 2.4-4.8 s is consistent). Not measured | Viable for a few seconds of 360p clips only |
| **ONNX Runtime / OpenVINO for Compact/SPAN** | same models exported to ONNX | ORT MIT / OpenVINO Apache-2.0 **[E]** | No CPU benchmark found for SRVGGNetCompact/SPAN. Related facts: SPAN 2x ONNX on RTX A6000 at 360x480 = 16.29 ms (CUDA EP), 10.46 ms (TRT) **[V arXiv 2602.11339 summary]**; an AMD Ryzen AI note says the pixel-shuffle tail took ~70% of NPU time for SPAN/SRVGGNetCompact **[V]**; a YOLOv8 CPU benchmark ranked OpenVINO fastest, ORT second, PyTorch slowest on Intel desktop CPUs **[V, not SR]** | Colab CPUs are 2 vCPU (usually Intel Xeon), so OpenVINO may give a 1.5-3x gain over PyTorch fp32 **[E]**; needs a measurement spike. Effort M (export, static shapes, tiling). Not worth it before GPU presets |

---

## 8. Integration notes, risks, and open questions

1. **Colab toolchain** (verified facts in `docs/spikes/realesrgan.md`): `realesrgan`/`basicsr` PyPI packages are 2022-era with no `requires_python` and need a patched `basicsr` plus a torchvision import rewrite **[V]**. Every candidate that is "basicsr-based" (GFPGAN, RestoreFormer++, CodeFormer, AnimeSR, RealBasicVSR, BasicVSR++) inherits that fragility; spandrel-served ones do not.
2. **No custom CUDA ops** in spandrel archs, SRVGG/Compact, SPAN, RealPLKSR, DAT, HAT **[E; spandrel is pure Python by design, per its PyPI dependency list]**. Custom ops/compiles: FlashVSR (Block-Sparse-Attention), BasicVSR++/RealBasicVSR (mmcv).
3. **fp16 on T4**: DAT/HAT got bf16 support in spandrel 0.4.2 **[V]**, which hints fp16 may overflow for some transformer archs. The spike must check `model.supports_half` and compare fp16 vs fp32 on a hard frame.
4. **Temporal**: for frame-wise SR, flicker on GAN textures is expected **[E]**; fp16 deterministic ops will not fix this. A cheap mitigation (not researched): prefer MSE-leaning/"conservative" models for video, e.g. Real-CUGAN conservative (2x/3x/4x) **[V list]**.
5. **Licence hygiene**: the repo is public and a shared service for <=5 users. Prefer CC-BY-4.0 / MIT / Apache-2.0 models; store licence + source URL + SHA-256 for each weight in the preset definition; do not commit weights. Treat 4x-UltraSharp (NC-SA), CodeFormer (NC), APISR (GPL + academic-only wording) as "operator-only, not bundled".
6. **Presets coefficients**: new `secPerMegapixelFrame` values in this doc are estimates **[E]**; measure each on T4 before enabling (same method as `docs/spikes/realesrgan.md`).
7. **Open questions to answer in spikes**: (a) spandrel on Colab Py 3.13 install; (b) SPAN / RealPLKSR / Compact s/MP on T4 fp16; (c) SeedVR2 fp16 stability; (d) MoTSR quality on real clips, and its PyTorch path speed vs TensorRT; (e) Real-CUGAN weights licence (ask upstream or restrict to personal use).

---

## 9. Sources

Verified-source URLs (fetched 2026-10-14):

spandrel / loaders
- https://github.com/chaiNNer-org/spandrel (README: licence, arch list, usage)
- https://pypi.org/pypi/spandrel/json (0.4.2, 2026-02-21, requires_python >=3.10)
- https://pypi.org/pypi/spandrel_extra_arches/json (0.2.0, 2024-09-16)
- https://github.com/chaiNNer-org/spandrel/releases (release notes)
- https://raw.githubusercontent.com/chaiNNer-org/spandrel/main/libs/spandrel/spandrel/__helpers/model_descriptor.py (descriptor API)
- https://api.github.com/repos/chaiNNer-org/spandrel (pushed_at 2026-04-12)

Models / model DBs
- https://openmodeldb.info/ , https://openmodeldb.info/models/4x-UltraSharp (CC-BY-NC-SA-4.0), https://openmodeldb.info/models/4x-Nomos8kSC (CC-BY-4.0)
- https://github.com/Phhofm/models (model list, speed benchmark) and https://raw.githubusercontent.com/Phhofm/models/main/README.md
- https://huggingface.co/Phips/4xNomos2_realplksr_dysample , https://huggingface.co/Phips/4xRealWebPhoto_v4_dat2 , https://huggingface.co/Phips/2xNomosUni_span_multijpg , https://huggingface.co/Phips/2xHFA2kCompact
- https://huggingface.co/spaces/Phips/Upscaler/raw/main/app.py (model name list)
- https://github.com/xinntao/Real-ESRGAN (+ docs/model_zoo.md); https://api.github.com/repos/xinntao/Real-ESRGAN (BSD-3-Clause, pushed 2024-08-06)
- https://github.com/hongyuanyu/SPAN (Apache-2.0, NTIRE 2024 ESR winner, SPAN-F NTIRE 2025)
- https://github.com/zhengchen1999/DAT (params, Apache-2.0), https://github.com/XPixelGroup/HAT (Apache-2.0)
- https://github.com/bilibili/ailab/tree/main/Real-CUGAN , https://raw.githubusercontent.com/bilibili/ailab/main/Real-CUGAN/README_EN.md , https://raw.githubusercontent.com/bilibili/ailab/main/Real-CUGAN/LICENSE (MIT)
- https://github.com/Kiteretsu77/APISR , https://raw.githubusercontent.com/Kiteretsu77/APISR/main/docs/model_zoo.md , https://github.com/Kiteretsu77/APISR/blob/main/LICENSE (GPL-3.0)
- https://github.com/nagadomi/nunif , https://github.com/nagadomi/waifu2x , https://api.github.com/repos/nagadomi/nunif

Video / temporal
- https://github.com/IceClear/SeedVR2 , https://huggingface.co/ByteDance-Seed/SeedVR2-3B , https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler , https://huggingface.co/numz/SeedVR2_comfyUI/tree/main , https://github.com/ByteDance-Seed/SeedVR/issues/54
- https://github.com/OpenImagingLab/FlashVSR , https://huggingface.co/JunhaoZhuang/FlashVSR-v1.1 , https://github.com/naxci1/ComfyUI-FlashVSR_Stable , https://forum.comfy.org/t/i-built-a-flashvsr-node-for-comfyui-4k-video-upscaling-that-auto-tiles-to-your-vram-16-gb-cards-included/4609
- https://github.com/zhengchen1999/DOVE , https://github.com/NJU-PCALab/STAR , https://github.com/Vchitect/VEnhancer , https://github.com/sczhou/Upscale-A-Video
- https://github.com/ckkelvinchan/RealBasicVSR , https://github.com/ckkelvinchan/BasicVSR_PlusPlus , https://arxiv.org/abs/2104.13371 , https://github.com/Yuehan717/RealViformer , https://arxiv.org/html/2407.13987v1 (Table 2: 5.3M / 49 ms vs RealBasicVSR 6.3M / 73 ms)
- https://github.com/TencentARC/AnimeSR , https://github.com/TencentARC/AnimeSR/blob/main/LICENSE (Apache-2.0)
- https://github.com/XYETHER/MoTSR , https://raw.githubusercontent.com/XYETHER/MoTSR/main/validation.json , https://api.github.com/repos/XYETHER/MoTSR , https://github.com/umzi2/MoSR
- https://github.com/filippawlicki/nanovsr , https://arxiv.org/abs/2607.10495
- https://arxiv.org/abs/2606.09250 (LiteVSR, no code link), https://github.com/karailker/restorax
- https://github.com/topics/video-super-resolution?o=desc&s=updated (2026 repo landscape)

Face
- https://github.com/TencentARC/GFPGAN , https://pypi.org/pypi/gfpgan/json , https://pypi.org/pypi/basicsr/json , https://pypi.org/pypi/realesrgan/json
- https://github.com/sczhou/CodeFormer , https://raw.githubusercontent.com/sczhou/CodeFormer/master/LICENSE (non-commercial)
- https://github.com/wzhouxiff/RestoreFormerPlusPlus

CPU
- https://github.com/opencv/opencv_contrib/tree/4.x/modules/dnn_superres , https://github.com/Saafke/FSRCNN_Tensorflow
- https://github.com/tomhda/ryzen-ai-npu-super-resolution-notes (via web search summary), arXiv 2602.11339 (via web search summary; not opened)

GitHub `pushed_at` / licence fields via `api.github.com/repos/<owner>/<repo>` for: spandrel, Real-ESRGAN, APISR, FlashVSR, ComfyUI-SeedVR2_VideoUpscaler, RealBasicVSR, BasicVSR_PlusPlus, AnimeSR, DOVE, STAR, VEnhancer, Upscale-A-Video, CodeFormer, GFPGAN, RestoreFormerPlusPlus, bilibili/ailab, nunif, MoTSR, RealViformer, Phhofm/models.

Items marked **[E]** are inferences by the researcher and should be re-measured before they drive presets or limits.
