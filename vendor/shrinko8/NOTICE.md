# Shrinko8 attribution

Shrinko8 **1.2.7f**, commit [`fb6e66827d481020857d7548fdd9dd0171315a86`](https://github.com/thisismypassport/shrinko8/tree/fb6e66827d481020857d7548fdd9dd0171315a86), copyright thisismypassport, MIT license (`LICENSE`).

The packaging tool copies the 24 unmodified top-level Python modules listed in `../minifier-lock.json` into a deterministic ZIP. All names, archive hashes, bundle hash and sizes are pinned. The engine ZIP excludes the upstream website, `scripts/` (including Parens-8), templates, fonts, test data and optional Python packages.

`suite_bridge.py` is Suite-owned integration code, not an upstream modification. It calls the upstream CLI entry point with a fixed argument array. It never executes submitted Lua or accepts custom Python, compiler scripts or arbitrary command-line arguments.
