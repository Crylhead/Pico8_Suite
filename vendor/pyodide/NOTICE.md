# Pyodide runtime attribution

The optional Minifier packages the unmodified **Pyodide 314.0.7** runtime from its official npm distribution, containing **CPython 3.14.2**. Exact URLs, archive/file SHA-256 values and byte sizes are in [`../minifier-lock.json`](../minifier-lock.json).

- Pyodide contributors: [source tag 314.0.7](https://github.com/pyodide/pyodide/tree/314.0.7), Mozilla Public License 2.0; full text in `LICENSE`.
- Python Software Foundation and contributors: [CPython v3.14.2 source](https://github.com/python/cpython/tree/v3.14.2), Python licensing history/terms in `PYTHON-LICENSE`; additional upstream notices in `CPYTHON-THIRD-PARTY-NOTICES.txt`, copied from that version's `Doc/license.rst`.
- The JavaScript loader, Emscripten-generated module, WASM and standard-library archive are official runtime build artifacts. Their corresponding sources/build recipes and dependency notices remain available in the above pinned upstream releases. This integration does not modify those binaries.

No third-party Python wheels are installed by this integration. In particular, Pillow, micropip, lupaz8 and Parens-8 are not packaged or loaded. The browser test executable is a development-environment dependency and is not distributed with the Suite.
