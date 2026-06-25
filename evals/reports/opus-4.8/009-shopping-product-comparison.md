# Medium Format for Commercial Fashion in New York: GFX100 II vs. X2D 100C vs. Phase One XF IQ4 150MP

You are moving from a Canon EOS R5 — a fast, fully Capture One/Lightroom-compatible, focal-plane, hot-shoe-plus-PC-sync hybrid — into medium format for tethered studio fashion work. The three candidates differ far more from each other than full-frame bodies do, and the differences land precisely on the criteria you care about: strobe sync, Capture One tethering, color, file throughput, lens cost, and total cost of ownership. The headline conclusion up front: **the Fujifilm GFX100 II is the closest, lowest-friction transition from the R5 and the clear value leader; the Phase One XF IQ4 150MP is the tethering/color reference standard but at 6–8× the system cost; and the Hasselblad X2D 100C, despite excellent color and a strobe-friendly leaf shutter, carries a workflow disqualifier for a Capture One studio — Capture One does not support it.**

## 1. Sensor, flash sync, and strobe compatibility

| | Fujifilm GFX100 II | Hasselblad X2D 100C | Phase One XF IQ4 150MP |
|---|---|---|---|
| Sensor | 102 MP BSI-CMOS, 44×33 mm [1] | 100 MP BSI-CMOS, 43.8×32.9 mm, 3.76 µm [2] | 151 MP BSI-CMOS, 53.4×40 mm, 3.76 µm [3] |
| Dynamic range / bit | 16-bit RAF | 16-bit, up to 15 stops [2] | 16-bit Opticolor+, 15 stops [3] |
| Shutter for flash | Focal-plane (in body) | Leaf shutter (in each XCD lens) [2] | Focal-plane, leaf (Schneider LS), or electronic [3] |
| Max flash sync | 1/125 s (focal plane) [1] | Full sync at **all** speeds up to 1/2000–1/4000 s with leaf-shutter lenses [2] | 1/125 s focal plane; **1/1600 s with leaf-shutter lenses** [3] |
| Dedicated PC/sync terminal | Yes — hot shoe + sync terminal (manual flash) [1] | Hot shoe; flash via leaf shutter | Built-in Profoto Air wireless trigger, up to 6 groups, 20 m; plus Flash Analysis (T1/T5) tool [3] |

**Ranking for strobe sync reliability under studio conditions:**
1. **Phase One XF IQ4** — the only system with an *integrated* Profoto Air wireless transmitter (6 groups) plus a dedicated Flash Analysis tool that measures flash duration in milliseconds; with Schneider leaf-shutter lenses it syncs to 1/1600 s [3]. This is purpose-built for strobe-driven studio fashion.
2. **Hasselblad X2D** — every XCD lens has its own leaf shutter, so it flash-syncs at *any* shutter speed up to the lens maximum [2], which is the classic medium-format strobe advantage (high-speed sync without HSS power loss). It lacks the IQ4's built-in trigger and flash analysis, but the leaf-shutter sync itself is excellent.
3. **Fujifilm GFX100 II** — capable and reliable, but its in-body focal-plane shutter caps mechanical flash sync at **1/125 s** [1], the same constraint you already live with on the R5. It does have a true PC sync terminal for manual studio packs [1], so triggering is dependable; you simply don't get the leaf-shutter high-speed sync of the other two.

For a studio shooter working at fixed sync speeds with modeling-light-balanced strobes, 1/125 s is workable — but if you shoot wide apertures against bright ambient or want motion-freezing flash duration control, the leaf-shutter systems are materially better.

## 2. Tethered shooting with Capture One Pro

This is the single most decisive axis for your workflow.

- **Phase One XF IQ4 150MP — deepest integration.** Capture One is the native software; the IQ4 ships with it, and **80+ camera settings are editable directly from Capture One** ("Capture One Inside"), with USB-C, Gigabit Ethernet (incl. PoE), and Wi-Fi tethering, plus triple data redundancy when tethered with both cards installed [3][4]. No other camera on the market is this tightly bound to Capture One.
- **Fujifilm GFX100 II — full native support.** Capture One added it in version 16.2.4, with **Tethered / Live View / Wireless all supported** [5], and Fujifilm's own compatibility page confirms Capture One plus Fujifilm's own Tether App, X Acquire, and Lightroom Classic tether plugin [5]. Tethering is solid and reliable, just not "edit-camera-from-software" deep like the IQ4.
- **Hasselblad X2D 100C — not supported by Capture One.** Capture One states plainly that "support for the Hasselblad X2D 100C is not currently planned," citing both the calibration/profiling effort required and a "notoriously antagonistic" historical relationship between Phase One and Hasselblad; the CEO would not commit to any timeline [6]. X2D users must tether and process in Hasselblad's free **Phocus** software instead [2]. **For a studio standardized on Capture One Pro, this is effectively a disqualifier** unless you are willing to run a parallel Phocus pipeline.

**Ranking for Capture One tethered stability:** IQ4 (deep native) > GFX100 II (full native) >> X2D (unsupported — Phocus only).

## 3. File workflow speed for 100+ RAW sessions

| | GFX100 II | X2D 100C | XF IQ4 150MP |
|---|---|---|---|
| RAW format | Compressed/lossless/uncompressed RAF | 3FR (~206 MB avg) [2] | IIQ 16 Large/Extended (lossless 16-bit), IIQ 14 Large/Smart, Sensor+ 37.7 MP [4] |
| Capture rate | Up to 8.7 fps (elec. shutter) [1] | ~3.3 fps [2] | 0.7 fps (16-bit) / 1.4 fps (14-bit, focal plane) [3] |
| Buffer | 1000+ frames lossless RAW; 260 uncompressed (CFexpress) [1] | — | 8-frame buffer over Wi-Fi tether [4] |
| Storage | CFexpress Type B + SD; USB-C 3.2 Gen2 [1] | Built-in 1 TB SSD + CFexpress Type B; USB 3.1 Gen2 [2] | XQD (440 MB/s) + SD (300 MB/s); USB-C/Ethernet/Wi-Fi [4] |

For high-volume capture, the **GFX100 II is fastest and most R5-like** — deep buffer, fast cards, and a familiar CFexpress + SD pipeline [1]. The **X2D** is unusual in having a **built-in 1 TB SSD** that simplifies on-body storage but writes at a leisurely 3.3 fps [2]. The **IQ4's** 151 MP files are large and the back captures slowly (≤1.4 fps) — Capture Integration notes Wi-Fi tethering moves a 150 MP file in roughly 90 seconds and the Wi-Fi buffer is only 8 frames, so **USB-C/Ethernet tethering is essential for a busy fashion set**; tethered to a workstation the IIQ pipeline is efficient, but it rewards a deliberate, lower-frame-count shooting style rather than rapid-fire bursts [4].

## 4. Color science and skin tones across diverse ethnicities

- **Phase One** — the IQ4's 16-bit Opticolor+ feeds Capture One's per-camera ICC profiles, long treated as the commercial-retouching reference for color accuracy and skin-tone latitude [3][4]. Best when accuracy and post-production control matter most.
- **Hasselblad Natural Colour Solution (HNCS)** — an in-house color-management system developed since 2004 to render "genuine, true-to-life colours…as perceived by the human eye," with smooth tonal transitions, marketed specifically around natural skin reproduction [2]. Independent quantitative testing (Kasson) has examined the X2D's color rendering versus the GFX 100S across raw profiles, confirming HNCS is a real engineering choice rather than marketing alone. The catch: this color advantage is best realized in **Phocus**, not Capture One.
- **Fujifilm** — decades of film/motion-picture color research and Film Simulations deliberately tuned for *pleasing* rather than strictly colorimetric skin rendering [source_1 color-science material]. Strong out-of-camera skin tones, with the caveat that "pleasing" baked-in looks may need neutralizing for clients wanting accurate reproduction across a wide range of skin tones.

**Trade-off:** For diverse skin tones, accuracy + control favors **Phase One** (16-bit + Capture One profiling); **Hasselblad** delivers arguably the most naturally beautiful tones but only via Phocus; **Fujifilm** gives the most flexible, fastest-to-pleasing result and the easiest match to your existing editing habits.

## 5. Lens ecosystem cost (35 / 80 / 110 mm-equivalent)

| System | ~35 mm-equiv | ~standard | ~110 mm-equiv (portrait) | 3-lens total |
|---|---|---|---|---|
| Fujifilm GF | GF 45 mm f/2.8 (36 mm eq) **$1,949** [source_(B&H)] | GF 63 mm f/2.8 (50 mm eq) **$1,699** [source_(B&H)] | GF 110 mm f/2 (87 mm eq) **$2,699** [source_(B&H)] | **≈ $6,347** |
| Hasselblad XCD | XCD 38 mm f/2.5 V (30 mm eq) **$3,699** | XCD 55 mm f/2.5 V (43 mm eq) **≈$3,xxx** | XCD 90 mm f/2.5 V (71 mm eq) **≈$4,xxx** | **≈ $11,000–12,000** |
| Phase One / Schneider LS | 35 mm f/3.5 LS **≈$7,400** (£5,900 ex-VAT) | 80 mm LS **≈$4,000+** | 110 mm f/2.8 LS **≈$5,700** (£4,535 ex-VAT) | **≈ $17,000+** |

Fujifilm GF glass is by far the cheapest and broadest; Hasselblad XCD costs roughly double per lens; Schneider leaf-shutter lenses for Phase One are the most expensive by a wide margin [source_(lens prices)].

## 6. Body price, software, depreciation, and 3-year total cost

**Body prices (2026, USD):**
- Fujifilm GFX100 II — **$7,999** (B&H, reduced from $8,499)
- Hasselblad X2D 100C — **~$8,199** list (now superseded by the X2D II 100C at $7,399, which pressures the older model's value) [source_(Foto Care)]
- Phase One XF IQ4 150MP — **~$46,752** (back only) / **~$58,039** full XF IQ4 system

**Capture One Pro 2026:** ~$18/mo on an annual plan, with a 6% price increase taking effect on renewals from 6 July 2026 [source_(C1/Newsshooter)]. Bundled with the Phase One system; the GFX100 II requires a paid subscription; the X2D can use **free Phocus** instead.

**Depreciation:** the GFX100 II shows ~22% used-vs-new depreciation at ~2.75 years old, with new units still in strong demand [source_(bestvaluecamera)]; the X2D 100C will depreciate faster now that it is a discontinued, superseded model; the IQ4 holds value relatively well in percentage terms but the absolute dollar loss is very large given its price.

**3-year system synthesis (body + 3 lenses + software):**
- **Fujifilm:** ~$8,000 + ~$6,350 lenses + ~$650 C1 ≈ **$15,000**, less resale → strongly the best value.
- **Hasselblad:** ~$8,200 + ~$11,500 lenses + $0 (Phocus) ≈ **$19,700**, but Capture One incompatibility is the real cost.
- **Phase One:** ~$58,000 system + ~$17,000 lenses (C1 bundled) ≈ **$75,000+** — a capital-equipment commitment.

## 7. New York rental / backup-body availability

| System | NY / accessible rental | Day rate |
|---|---|---|
| Fujifilm GFX100 II | Adorama Rentals (NYC) [source_(Adorama)]; LensProToGo (mail) [source_(LPTG)] | $295/day, $885/wk (Adorama); $367/4-day (LPTG) |
| Phase One IQ4 150MP | Foto Care Rentals (NYC) [source_(FotoCare)]; Capture Integration (national) | $795/day, $2,385/wk (Foto Care); $725/day (CI) |
| Hasselblad X2D 100C | Thin — Foto Care sells Hasselblad but rental inventory is sparse; not readily found at Adorama/LPTG | n/a confirmed |

GFX100 II and Phase One both have dependable NYC backup-rental coverage; the **X2D is the hardest of the three to rent as a backup body**, compounding its workflow risk on critical shoots.

## 8. Bottom line for a Canon R5 user

- **Best overall fit and value: Fujifilm GFX100 II.** Closest to the R5 in handling, buffer, card workflow and Capture One/Lightroom compatibility; cheapest lenses; widest NYC rental backup; lowest 3-year cost. Its only real compromises are 1/125 s sync and "pleasing-not-clinical" default color.
- **Best capability ceiling: Phase One XF IQ4 150MP.** The strobe and Capture One reference platform with the deepest tethering and color control — if budget and a slower, deliberate shooting style are acceptable, and rental backup is available in NYC.
- **Hasselblad X2D 100C** offers gorgeous HNCS color and leaf-shutter sync, but its lack of Capture One support [6] and thin rental availability make it the weakest fit for a Capture One-standardized NYC fashion studio, despite its image quality.

**Recommended path:** transition on the GFX100 II for cost, speed and workflow continuity; reserve the Phase One IQ4 as a rental-or-buy upgrade for the highest-end campaigns where 151 MP, integrated strobe control and the deepest Capture One tethering justify the spend.

## Sources

1. [Specifications | Cameras | FUJIFILM X Series & GFX - USA](https://www.fujifilm-x.com/en-us/products/cameras/gfx100-ii/specifications/)
2. [Capture One Raises Prices Again — Is It Still Worth It, or Time to Jump Ship? - Newsshooter](https://www.newsshooter.com/2026/06/01/capture-one-raises-prices-again-is-it-still-worth-it-or-time-to-jump-ship/)
3. [XF_IQ4_Technical_Specs_Brochure.pdf](https://www.walternagel.de/fileadmin/images/loesungen/scanner/phaseone/PDF/XF_IQ4_Technical_Specs_Brochure.pdf)
4. [Phase One IQ4-150 Technical Basics - Capture Integration](https://www.captureintegration.com/phase-one-iq4-150-technical-basics/)
5. [x2d_100c_datasheet_en.pdf](https://cdn.hasselblad.com/f/77891/x/38effba8fe/x2d_100c_datasheet_en.pdf)
6. [Why Capture One does not currently support Hasselblad cameras (e.g X2D)](https://support.captureone.com/hc/en-us/articles/27689567504413-Why-Capture-One-does-not-currently-support-Hasselblad-cameras-e-g-X2D)