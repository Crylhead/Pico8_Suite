# Compression in data carts: decisions

Decided with the user on 2026-10-29, after benchmarks in PICO-8 0.2.7. Nuova and Modulator shipped without compression: they need no unpacker, start faster and spend no tokens on one. That only worked because the data just fit. Compression is therefore an option for when a demo does not fit, never the default.

## Implementation status

This standalone repository implements **raw storage and byte LZ only**. Target-cart compression and gamma LZ remain proposals. The measurements below are historical PICO-8 0.2.7 reports from Demotools, not benchmarks shipped with this repository or independently rerun on 2026-11-01. Token counts and timings depend on the exact decoder, runtime and workload.

## Decisions

1. **Raw by default.** It costs no tokens and no CPU, and a `reload()` is the only cost.
2. **Byte LZ (`unlz`, 60 tokens) is the codec for data unpacked at a cut.** It unpacks 17 KB in about 0.1 frame, so a cut stays within budget.
   - Since 2026-10-29 the encoder in `cart-core.js` uses dynamic programming over a bounded match search (default chain limit 1024); this is not a guarantee of the global minimum over every possible match. The format and the decoder are unchanged, so existing carts and anchors keep working.
   - The new encoder output was checked in PICO-8: 248 of 248 unpacks byte-exact.
3. **Compress only what saves a cart (planned).** The cart builder gets an option to compress parts only when the demo would otherwise need more carts than the target. Parts that shrink most go first: images and music patterns, and audio last.
4. **Gamma LZ (139 tokens) is an opt-in second codec, for data unpacked at boot only (planned).**
   - It packs about 13% smaller than byte LZ over all carts.
   - It takes 2–5 frames per 17 KB. During a cut that would drop frames, so it is only for data unpacked behind the boot screen.
   - Proposed behavior: the builder would warn when a gamma LZ anchor is in `init()` instead of `load()`; no such gamma codec or warning is implemented.
   - Proposed policy: use one codec per project so its decoder's tokens are paid once.
5. **Not offered:**
   - PX9: 214 tokens and 15–50 frames per cart. It beats gamma LZ on only 3 images and makes audio and tables bigger.
   - RLE: always worse than byte LZ, at about the same token cost.
   - Deflate or Huffman: the decoders are too big and too slow.

The fixed cost of `reload()` stays the same: about 0.23 frames per call for anything above 4 KB. Compression saves carts, not loading time.

## Measurements

The inherited benchmark notes report 35 data carts of Nuova and Modulator (579 KB), categorized as follows. The category counts sum to 36; without the original fixtures this discrepancy cannot be resolved, so do not treat this as a verified inventory:
- 13 image carts
- 4 uv/bump tables
- 2 music pattern carts
- 17 sample carts

Every packed cart was unpacked in PICO-8 and compared byte for byte with the source. Tokens were measured with the filler method from the optimization notes. Times are 30 fps frames from `stat(1)`, measured headless.

| Codec | Tokens | Size | Unpack per 17 KB (avg / max) |
|---|---|---|---|
| raw (`memcpy`) | 0 | 100% | 0.03 / 0.03 |
| RLE | 58 | 75.1% | 0.10 / 0.23 |
| byte LZ, greedy encoder (before) | 60 | 68.4% | 0.12 / 0.20 |
| **byte LZ, optimal encoder (now)** | 60 | 67.8% | 0.10 / 0.16 |
| lzs: byte LZ plus 1-byte offsets | 81 | 65.6% | 0.12 / 0.19 |
| **gamma LZ** (ZX0-style) | 139 | 58.6% | 2.4 / 4.6 |
| PX9, 4 bits per pixel | 214 | 71.7% | 18.9 / 31.7 |
| PX9, 8 bits per value | 214 | 74.4% | 15.6 / 52.6 |
| deflate (lower bound only) | – | 56.2% | – |

Size by kind of data:

| Data | byte LZ | lzs | gamma LZ | PX9 (4 bit) | deflate |
|---|---|---|---|---|---|
| Images | 39% | 36% | 30% | 34% | 29% |
| Music patterns | 16% | 14% | 12% | 22% | 11% |
| uv / bump tables | 97% | 95% | 89% | 100% (bigger) | 83% |
| Audio samples | 88% | 86% | 78% | 99% (bigger) | 76% |

Data carts needed, packed first-fit decreasing with one source cart per part:

| Demo | raw | byte LZ | gamma LZ | gamma LZ, audio raw |
|---|---|---|---|---|
| Modulator | 25 | 19 | 17 | 19 |
| Nuova | 10 | 6 | 6 | 6 |

PICO-8 0.2.7 can bundle up to 32 carts per export.

## Formats

**Byte LZ** (`cart-core.js`, `lzEncode` / `lzDecode` / `LZ_LUA`): `[len lo, len hi]`, then tokens.

| Token | Meaning |
|---|---|
| `0..127` | literal run of n+1 bytes |
| `128..255` | match of n−125 bytes (3..130) from a 16-bit offset back in the output |

Matches never overlap their source, so `memcpy` is always correct.

**Gamma LZ** (planned; the historical prototype is not included in this repository):
- Control bits are read LSB first from bytes fetched when needed. Literals and offset low bytes sit byte-aligned in the same stream.
- The stream is `gamma(n+1)`, then tokens:
  - literal: `0`, `gamma(L)`, then L bytes
  - match: `1`, `gamma(hi)`, the low offset byte, `gamma(len−1)`, where `off−1 = (hi−1)·256 + lo`
- The encoder parses optimally. Matches don't overlap, so `memcpy` works.

The decoder (139 tokens, measured):

```lua
function unzx(s,d)
 local b,n=0,0
 local function g()
  if(n<1)b,n,s=@s,8,s+1
  n-=1 local r=b&1 b>>=1 return r
 end
 local function v()
  local k,r=0,1
  while(g()<1)k+=1
  for i=1,k do r=r*2+g() end
  return r
 end
 local e=d+v()-1
 while d<e do
  if g()<1 then local l=v() memcpy(d,s,l) s+=l d+=l
  else local o=v()*256+@s-255 s+=1 local l=v()+1 memcpy(d,d-o,l) d+=l end
 end
end
```

## Reproducing

This repository does **not** contain `pico-8/carts/compress_bench/`, its generators/analyzer, the demo input carts or the timing logs. The tables cannot be regenerated from this checkout alone.

With the original benchmark checkout and matching data carts available, the historical procedure was:

1. From the benchmark directory, `node src/gen.js <bench dir> <data carts…>` generated packed/source carts, `bench.p8` and token-count carts.
2. `pico8.exe -x bench.p8` wrote `bench_out.txt` with sizes, timings and byte comparisons.
3. `node src/analyze.js` summarized the results.

For checks available here, see [CONTRIBUTING.md](../CONTRIBUTING.md). A JavaScript encoder/decoder round trip checks internal consistency; it does not independently validate PICO-8 runtime compatibility.

