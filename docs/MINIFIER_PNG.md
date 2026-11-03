# Optional PNG cartridge export — MIN-11 / #129

For a current successful `.p8` result, **Download… → Download name.min.p8.png** produces a separate optimized cartridge image. `.lua` input offers `.min.lua`; a complete original cartridge is required for PNG. Text `.p8` and `.lua` actions keep their existing behavior and order.

Download the actual file and drag it into PICO-8 to load it, then `run`. Do not screenshot, resize or re-encode the image: its low pixel bits carry cartridge data. PNG import into Minifier remains unsupported.

## Dependencies and measured cost

The pinned upstream Shrinko8 **1.2.7f**, commit `fb6e66827d481020857d7548fdd9dd0171315a86`, normally writes images using Pillow, `template.png` and `font.png`. Its `write_cart_to_rom` serializer/compressor does not need those image dependencies. Ordinary cartridge PNG export does **not** require `pico8.dat`; other upstream runtime/export workflows use that data.

The Suite calls the unchanged pinned ROM serializer and writes a simple original cartridge frame plus the retained label through `suite_png.py`, using Python's existing `base64`, `json`, `struct` and `zlib` modules. No Pillow wheel, extra WASM package, artwork/font download, `pico8.dat`, CDN or Python server bridge is required. The existing Shrinko8 MIT attribution remains in [its notice](../vendor/shrinko8/NOTICE.md). The PNG envelope/frame is Suite-owned code; upstream artwork is not copied.

Measured addition: **4,223 bytes** of optional local Python source (**1,759 gzip bytes**, compression measured for comparison; the simple local server may serve it uncompressed), one same-origin worker startup request, and **zero extra packaged runtime/archive bytes**. Existing pinned engine/Pyodide archives remain unchanged. PNG image construction uses a 32,800-byte ROM/trailer and 131,405 raw filtered RGBA bytes before zlib compression; this is buffer sizing, not a measured peak heap claim.

If the optional module is missing or cannot import, the core engine still initializes with `capabilities.png=false`. The download dialog explains that PNG is unavailable and offers the existing text formats. Restore the complete Suite folder and Retry engine to re-detect availability. No proprietary file upload or silent remote fallback exists.

## Encoding and preservation

The PNG contains 160×205 RGBA pixels, matching the pinned upstream format. Each cartridge byte uses two low bits of B, G, R and A in upstream order. Shrinko8 supplies the ROM, compressed code, cartridge version and SHA-1 trailer. The Suite encodes lossless PNG chunks and CRCs using standard-library zlib; it does not pass data through a browser canvas or lossy image conversion.

The label is copied at upstream's 128×128 position (16,24); a missing label uses black. Graphics, map, flags, SFX, music and code retain their decoded cartridge values. PNG does not retain arbitrary text-only section metadata, original header spelling, source comments or editable project structure. Keep the original authoring cart.

Export accepts the preservation-validated `.p8` artifact, disables include preprocessing/file reads, checks syntax and budgets, serializes with pinned Shrinko8 and verifies the serialized code/ROM/version before encoding. A source/result change while encoding prevents download. Cancel or workspace navigation terminates an active PNG request; failures do not replace the accepted text result. Download is a binary `image/png` operation under a distinct `.min.p8.png` filename, never a project Save or overwrite.

## Code capacity versus image size

The [PICO-8 0.2.7 manual](https://www.lexaloffle.com/dl/docs/pico-8_manual.html) specifies compressed code **less than 15,360 bytes** for PNG/ROM export. The Suite enforces that published budget, plus 8,192 tokens and 65,535 characters. It also checks the pinned serializer's physical code region (**15,616 bytes**) and full ROM/trailer size. The published budget is deliberately stricter than the physical region; the two values are not interchangeable.

Compression is forced through the pinned serializer so the reported count includes its compression header. A capacity failure returns `E_PNG_CAPACITY` and no base64/image artifact. Output requests report both **Compressed code: N bytes** and **PNG image: M bytes**; image file size cannot substitute for code capacity. Ordinary `.p8`/`.lua` exports remain available when PNG capacity is exceeded.

## Verification record

The representative fixture is [representative.min.p8.png](../tests/fixtures/minifier/release/representative.min.p8.png), generated from the existing representative cart. Native tests use Shrinko8's independent PNG reader (test-only local Pillow) to recover and compare complete ROM, code, version and label. Separate tests forbid Pillow imports and runtime-data file opens during encoding; invalid/unresolved sources and token/character/compressed overflow produce no partial output. Node tests cover optional capability detection, PNG response identity, recoverable refusal, binary downloads and source changes during encoding.

Browser verification: **Chromium 153.0.8010.0** ran the real local Pyodide/Shrinko8 worker. The representative cart downloaded as a **1,150-byte PNG**, with **136 compressed code bytes**. Its SHA-256 is `b5c8d90fb736370f1565ba7c1c13a596de4d039e699b0c778aa152d18bd07f57`. Offline-after-initialization encoding, missing optional encoder/retry, stale source replies, navigation cancellation, over-capacity refusal and retained text exports passed. Download dialogs were checked at 1440, 900 and 375px widths, including the 667px-tall phone viewport. No source upload, external request or browser page error occurred. Native decoding of the actual browser download matched the original code/ROM/version/label.

Final checks: **319 JavaScript regressions**, **15 Python tests** (9 real engine, 2 packaging, 4 PNG), static HTML/reference validation, changed-JS/Python syntax and diff checks passed. Native PNG reading uses test-only local Pillow; browser output does not.

**Installed-PICO-8 PNG validation: passed via user testing on 2026-11-03.** Following the original/optimized text-cart comparison in installed Windows PICO-8 0.2.7, the user loaded the supplied browser-generated `representative.min.p8.png` and confirmed “works fine!” in response to the requested visuals/startup-tone comparison. This completes the PNG-specific runtime requirement for #129. The console result is user-reported; the assistant did not run PICO-8 locally. It applies to this representative fixture, not every possible cartridge. [PR #144](https://github.com/Crylhead/Pico8_Suite/pull/144) is merged and [#129](https://github.com/Crylhead/Pico8_Suite/issues/129) is closed. The core release tracker #130 remains completed.
