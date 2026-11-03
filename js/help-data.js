// js/help-data.js
// Canonical help content (UX issue #59): structured, local, no network. Read through
// js/help-core.js (P8Help). Every top-level workspace (the data-value of #wsTabs) has exactly one
// kind:'tool' topic whose `ws` equals it; `legacy` names the long-form section of the F1 template
// in index.html (#docsTemplate) that keeps the full detail until this registry covers it.
// A tool or option change must update its topic (and `rev`) in the same PR; see EXTENDING.md.
//
// Topic: { id, kind: 'tool'|'guide'|'reference', ws?, title, summary, inputs[], outputs[],
//   tasks[] (what a user wants to do), actions[{id,name,text}], controls[{id,label,text}],
//   shortcuts[[keys, text]], restrictions[], related[ids], keywords[], legacy?, rev }
// Control ids are stable (`<tool>.<control>`); renaming one needs an entry in ALIASES.

'use strict';

const P8HelpData = (() => {
  const TOPICS = [
    {
      id: 'home', kind: 'tool', ws: 'home', title: 'Home', rev: 1,
      summary: 'Start page: shows what the Suite offers and leads to every tool.',
      inputs: [], outputs: [],
      tasks: ['find a tool', 'switch tools', 'start a new project', 'learn what the Suite does'],
      actions: [
        { id: 'home.continue', name: 'Continue', text: 'Offers your last tool and, if a project folder is known, a Continue or Reconnect button. A remembered folder is never opened automatically: Reconnect asks the browser for permission and only a granted folder is used. A denied, revoked or missing folder explains what to do.' },
        { id: 'home.tasks', name: 'What do you want to do?', text: 'Shortcuts grouped as Create, Edit, Import and Analyze, generated from the registered tools. A shortcut only switches to the tool (or one of its tabs); it never changes another tool’s work.' },
        { id: 'home.tools', name: 'Tool cards', text: 'Each card opens its workspace. Work stays in each tool while you switch.' },
        { id: 'home.storage', name: 'Where your work lives', text: 'The Library and tool sessions are saved in this browser only, not as files; export a backup. Project folders are real files and need permission each visit. If the browser blocks storage, Home says the Library lasts only for this page.' },
      ],
      controls: [],
      shortcuts: [['F1', 'Open this help'], ['Ctrl+K', 'Go to tool']],
      restrictions: ['Home never opens a project folder by itself.'],
      related: ['suite', 'library', 'shortcuts'], keywords: ['start', 'launcher', 'welcome'], legacy: 'doc-suite',
    },
    {
      id: 'studio', kind: 'tool', ws: 'studio', title: 'Pixel Studio', rev: 2,
      summary: 'Pixel editor for sprites, sprite sheets and whole-map images with 16 palette slots mapped to the 32 PICO-8 colors, layers and frames.',
      inputs: ['PNG images', 'Library images', 'the gfx of a .p8 cart'],
      outputs: ['Library images', 'PNG', '.p8 gfx section'],
      tasks: ['draw a sprite', 'edit a sprite sheet', 'remap palette colors', 'animate with frames', 'create a tileable texture', 'save an image to the Library'],
      actions: [
        { id: 'studio.canvas', name: 'Canvas size', text: '1×1 to 1024×1024 with presets (sprite, 128×128 sheet, half sheet, whole map 1024×512). Orange dashed boxes mark 128×128 screens.' },
        { id: 'studio.tools', name: 'Drawing tools', text: 'Pencil, eraser, line, rectangle, ellipse, fill, color picker, selection tools, pan. Brush sizes 1–4 or a custom brush; mirror X/Y.' },
        { id: 'studio.ink', name: 'Ink', text: 'Normal, lock alpha, behind, shade and shade along the fades.' },
        { id: 'studio.sieve', name: 'Sieve and fill patterns', text: 'A sieve mask limits which pixels change; fill patterns use PICO-8 fillp() bits.' },
        { id: 'studio.layers', name: 'Layers and frames', text: 'Layers (bottom = background) and frames with onion skin; exports flatten the visible layers.' },
        { id: 'studio.send', name: 'Send to…', text: 'File › Send to lists every destination for the current image (Tile Maker, Palette & Fades preview, Map Editor tileset, Terrain Lab…) with the reason for each one that is unavailable. The destination gets a temporary copy: it is not saved to the Library until you save it.' },
        { id: 'studio.save', name: 'Save to Library', text: 'Ctrl+S makes the image available to the other tools. The working image is also autosaved in this browser. The Library gets the image as it was when you pressed Save: changes made while it is saving stay marked as edited. One save runs at a time.' },
      ],
      controls: [
        { id: 'studio.slot', label: 'Color slot', text: 'Double-click a slot (or Remap…) to choose which of the 32 PICO-8 colors it shows.' },
        { id: 'studio.transparent', label: 'Transparent slot', text: 'Empty pixels export as the transparent slot (default 0, like palt()).', detail: 'Pick the slot your cart passes to palt(), so exported empty areas stay see-through.' },
        { id: 'studio.tiled', label: 'Tiled view', text: 'Shows a 3×3 repeat; strokes wrap around the edges.', detail: 'Example: paint across the right edge and it continues on the left, so seams in a texture can be drawn directly.' },
      ],
      shortcuts: [['Ctrl+S', 'Save to Library'], ['Ctrl+Shift+S', 'Save as new Library image'], ['← / → on the panel splitter', 'Resize the side panel (Shift = larger steps; Home / End = narrowest / widest; Enter = hide / show; 0 = default)'], ['M / Q / W', 'Selection tools'], ['Ctrl+B', 'Make the selection a custom brush'], ['P', 'Pixel perfect'], ['V', 'Sieve'], ['Tab', 'Hide / show timeline'], ['F', 'Image-only view']],
      restrictions: ['Undo keeps up to 200 steps and about 160 MiB.', 'Palette slots are preserved; the screen palette decides the shown colors.'],
      related: ['palette', 'tiles', 'map', 'library'], keywords: ['sprite', 'draw', 'paint', 'pixel', 'gfx', 'layer', 'frame', 'animation'], legacy: 'doc-studio',
    },
    {
      id: 'palette', kind: 'tool', ws: 'palette', title: 'Palette & Fades', rev: 1,
      summary: 'Creates custom 16-color screen palettes from all 32 PICO-8 colors and generates dithered dark/bright fade tables as Lua code.',
      inputs: ['PNG (palette import)', 'saved palettes from the Library'],
      outputs: ['Lua palette / fade code', 'Library palettes', 'project files', 'greyscale-converted images'],
      tasks: ['make a custom palette', 'generate a fade table', 'import a palette from an image', 'convert an image to greyscale levels', 'preview fades on an image'],
      actions: [
        { id: 'palette.ramps', name: 'Ramps and Auto Fill', text: 'Each palette color gets a ramp; presets and Auto Fill propose ramps.' },
        { id: 'palette.fades', name: 'Fade ramps', text: 'Fade toward a dark and/or bright target with the fade parameters and the slider.' },
        { id: 'palette.export', name: 'Export', text: 'Copies ready-to-paste Lua for the palette and the fade tables.' },
        { id: 'palette.greyscale', name: 'Greyscale conversion', text: 'Maps brightness levels of an image onto palette colors.' },
      ],
      controls: [
        { id: 'palette.slider', label: 'Fade slider', text: 'Arrow keys move the focused slider.' },
        { id: 'palette.mode', label: 'Normal / Ramp mode', text: 'Switches between picking palette colors and editing ramps.' },
        { id: 'palette.side', label: 'Dark / Bright', text: 'Chooses which fade direction is edited.' },
      ],
      shortcuts: [['Ctrl+Alt+N', 'New project'], ['Ctrl+O', 'Open project'], ['Ctrl+S', 'Save project'], ['Ctrl+I', 'Import palette from PNG'], ['Del / Esc', 'Clear / deselect the selected slot']],
      restrictions: ['A palette holds 16 of the 32 PICO-8 colors.'],
      related: ['studio', 'tiles', 'extras'], keywords: ['color', 'fade', 'dither', 'pal', 'ramp', 'gradient'], legacy: 'doc-overview',
    },
    {
      id: 'tiles', kind: 'tool', ws: 'tiles', title: 'Tile Maker', rev: 3,
      summary: 'Checks whether a picture can be built from PICO-8 8×8 tiles and builds the tile sheet and map.',
      inputs: ['any image', 'custom palette from Palette & Fades'],
      outputs: ['tiles + map as .p8 cart', 'Library images and maps (Open in Map Editor)'],
      tasks: ['pack an image into tiles', 'reduce the unique tile count', 'check a screen-sized viewport against 256 tiles', 'edit tiles'],
      actions: [
        { id: 'tiles.import', name: 'Import Image', text: 'Converts to 16 colors (brightness ramp, custom palette by brightness, or nearest color); optional Floyd–Steinberg dither. A Library image with its own palette brings that palette and its fades along (nearest color) only once you accept replacing an unsaved tile set; Cancel changes nothing.' },
        { id: 'tiles.reduce', name: 'Tile reduction (MAE)', text: 'Raise it and press Rebuild to merge similar tiles until you are within 256.' },
        { id: 'tiles.viewport', name: 'Viewport and heatmap', text: 'Shows how many unique tiles a screen-sized window needs and where it is expensive.' },
        { id: 'tiles.edit', name: 'Edit Tiles…', text: 'Pixel editor for single tiles; Save Changes applies them.' },
        { id: 'tiles.tomap', name: 'Tiles + Map → Map Editor', text: 'Opens the tiles as the Map Editor tileset (sprite 0 stays empty when they fit) and the tile map as its map, as a temporary copy that is not in the Library. If the Map Editor has unsaved changes it first asks Replace / Cancel; Cancel changes neither tool.' },
      ],
      controls: [{ id: 'tiles.mae', label: 'Tile reduction (MAE)', text: 'Higher values merge more similar tiles.' }],
      shortcuts: [['Ctrl+I', 'Import image'], ['Ctrl+O', 'Open tile project'], ['Ctrl+S', 'Save tile project']],
      restrictions: ['A PICO-8 map addresses at most 256 tiles.', 'Changing the custom palette asks for a rebuild.'],
      related: ['map', 'studio', 'palette'], keywords: ['tileset', 'sprite sheet', 'viewport', 'mae', 'dither'], legacy: 'doc-tiles',
    },
    {
      id: 'map', kind: 'tool', ws: 'map', title: 'Map Editor', rev: 1,
      summary: 'Edits PICO-8 maps against a tileset, with 128×32 cart maps, 128×64 maps using the lower sheet half, and sizes up to 256×256.',
      inputs: ['tileset image (≤128×128)', '.p8 carts (map + sprites)', 'Library maps'],
      outputs: ['Library maps (with tileset and palette)', '.p8 cart', 'raw bytes', 'PNG'],
      tasks: ['paint a level map', 'import a map from a cart', 'write a map into an existing cart', 'copy and paste cell blocks'],
      actions: [
        { id: 'map.tools', name: 'Tools', text: 'Draw, rectangle fill, flood fill, pick, select, pan.' },
        { id: 'map.sizes', name: 'Map sizes', text: '128×32 is __map__; 128×64 also uses sprites 128–255 for rows 32–63.' },
        { id: 'map.p8', name: '.p8 import / write', text: 'New .p8 Cart writes map, sprites and a viewer; Write into Existing .p8 replaces only the map (and optionally sprites).' },
        { id: 'map.save-status', name: 'Save status', text: 'The badge beside the map name shows Not saved, Unsaved changes, Saving…, Saved to Library, Downloaded copy, memory-only, failed or conflict.' },
      ],
      controls: [{ id: 'map.status', label: 'Save status badge', text: 'Click it for details. "Saved" appears only after the browser confirmed the write.' }],
      shortcuts: [['Ctrl+Shift+S', 'Save as new Library map'], ['B / U / G / I / M / H', 'Draw / rectangle / fill / pick / select / pan'], ['[ ]', 'Previous / next tile'], ['0', 'Fit'], ['Ctrl+C / Ctrl+X', 'Copy / cut cells as brush']],
      restrictions: ['Other sizes are exported as bytes only.'],
      related: ['tiles', 'studio', 'cartbuilder', 'library'], keywords: ['level', 'tilemap', 'cells', 'mget', 'mset'], legacy: 'doc-map',
    },
    {
      id: 'code', kind: 'tool', ws: 'code', title: 'Code Editor', rev: 2,
      summary: 'Edits the __lua__ section of a .p8 cart or a .lua file with PICO-8 syntax, completion, token count and Run through the optional helper.',
      inputs: ['.p8 or .lua files', 'project folders'],
      outputs: ['the same file (Save)', 'PICO-8 run via the bridge'],
      tasks: ['edit cart code', 'count tokens', 'follow #include', 'run a cart'],
      actions: [
        { id: 'code.save', name: 'Save', text: 'Rechecks the current file, preserves external changes to non-Lua sections, and asks you to resolve concurrent Lua edits before saving.' },
        { id: 'code.run', name: 'Run', text: 'Saves and starts the cart in PICO-8 through tools/run_pico8_bridge.bat (needs Python). printh() output appears below the code. A .lua file runs the cart of the open folder that #includes it; after Open Folder switches to another folder, the old cart is never used: open the folder the cart is in to run it.' },
        { id: 'code.include', name: 'Folders and #include', text: 'Open Folder… lists carts; Ctrl+click an #include line to open it.' },
        { id: 'code.tabs', name: 'Code tabs', text: 'Jump to each -->8 tab; Functions lists every function.' },
      ],
      controls: [{ id: 'code.tokens', label: 'Token counter', text: 'Counts tokens (8192) and characters (65535), including #include files.' }],
      shortcuts: [['Ctrl+O', 'Open'], ['Ctrl+S', 'Save'], ['Ctrl+Shift+S', 'Save As…'], ['Ctrl+R', 'Run'], ['Ctrl+/', 'Comment'], ['Ctrl+D', 'Duplicate line'], ['Alt+↑/↓', 'Move lines'], ['Ctrl+F / Ctrl+H', 'Find / replace'], ['F3', 'Next match'], ['Ctrl+G', 'Go to line'], ['Ctrl+Shift+O', 'Functions']],
      restrictions: ['External changes to other cart sections are not merged: reopen after editing them elsewhere.', 'Run needs the Python helper; a web page cannot start programs.'],
      related: ['audit', 'datacarts', 'project-context'], keywords: ['lua', 'token', 'editor', 'syntax', 'include', 'run'], legacy: 'doc-code',
    },
    {
      id: 'data', kind: 'tool', ws: 'data', title: 'Data Tools', rev: 1,
      summary: 'Converts binary data and images into PICO-8 string literals and splits greyscale images into nibbles.',
      inputs: ['files', 'text', 'Library images'],
      outputs: ['Lua string literals with a reader function', 'nibble images (Library / PNG)'],
      tasks: ['embed a file as a Lua string', 'pack an image 4 bits per pixel', 'split high/low nibbles'],
      actions: [
        { id: 'data.string', name: 'Binary → PICO-8 string', text: 'Non-printable bytes become \\ddd escapes; images are packed in PICO-8 memory order or 1 byte per pixel.' },
        { id: 'data.nibble', name: 'Nibble split', text: 'Shows the high and low 4 bits of a greyscale image as colors 0–15.' },
      ],
      controls: [], shortcuts: [], restrictions: ['Strings count against the character and token limits of the cart.'],
      related: ['datacarts', 'studio'], keywords: ['binary', 'string', 'nibble', 'encode', 'peek'], legacy: 'doc-data',
    },
    {
      id: 'audit', kind: 'tool', ws: 'audit', title: 'Project Audit', rev: 1,
      summary: 'Scans a project folder in the browser: tokens and characters per cart (with #include), file references and unused carts.',
      inputs: ['a project folder (picker or drop)'],
      outputs: ['on-screen tables', 'CSV and JSON', 'copied summary'],
      tasks: ['count tokens in a project', 'find unused carts', 'check load/run/reload references'],
      actions: [
        { id: 'audit.scan', name: 'Choose Project Folder / Rescan', text: 'Reads every .p8 in the folder and subfolders locally; nothing is uploaded.' },
        { id: 'audit.summary', name: 'Project summary', text: 'Shows which carts are used and which nothing points to.' },
      ],
      controls: [{ id: 'audit.columns', label: 'Column checkboxes', text: 'Hide columns; click a header to sort.' }],
      shortcuts: [['Ctrl+O', 'Choose project folder'], ['F5', 'Rescan']],
      restrictions: ['Token counts are estimates following the PICO-8 rules.', 'A folder chosen with the button must be chosen again to rescan.'],
      related: ['code', 'datacarts', 'cartbuilder', 'project-context'], keywords: ['tokens', 'scan', 'unused', 'include', 'csv'], legacy: 'doc-audit',
    },
    {
      id: 'datacarts', kind: 'tool', ws: 'datacarts', title: 'Data Carts', rev: 2,
      summary: 'Shows what every data cart holds and which ranges the code reloads; packs new data carts and writes the reload() lines.',
      inputs: ['a project folder', '.p8 files', 'Library images'],
      outputs: ['.p8 data cart', 'reload() lines', 'Library images and palettes', 'range downloads'],
      tasks: ['inspect a memory map', 'view data as image or hex', 'pack a data cart', 'decide raw or LZ'],
      actions: [
        { id: 'datacarts.map', name: 'Memory map', text: '128 bytes per row. "No read detected" is a heuristic, not proof that bytes are free.' },
        { id: 'datacarts.view', name: 'View as', text: '4-bit image, palette/fade table, greyscale, hex or fixed-point plots.' },
        { id: 'datacarts.pack', name: 'Pack', text: 'Builds a data cart (17,152 bytes) from ranges, images and files and verifies the cart text before download.' },
      ],
      controls: [], shortcuts: [],
      restrictions: ['Detection of reads is heuristic: check the code before reusing bytes.', 'The project folder is shared with Project Audit: Open Project Folder… and Use the active project scan it there, and both tools then show it. .p8 files you open here stay until you choose a project folder again; a scan in Project Audit does not replace them.'],
      related: ['audit', 'cartbuilder', 'code', 'project-context'], keywords: ['reload', 'memory', 'lz', 'pack', 'hex'], legacy: 'doc-datacarts',
    },
    {
      id: 'cartbuilder', kind: 'tool', ws: 'cartbuilder', title: 'Cart Builder', rev: 2,
      summary: 'Manages a demo project’s data as assets packed into data carts, with --@data anchors telling the fx code where each piece is.',
      inputs: ['a demo project folder (contains demo/ or main.p8)', 'Library images and maps', 'files'],
      outputs: ['data carts', 'rewritten reload() lines', 'demo/suite.json'],
      tasks: ['adopt an existing project', 'pack assets into data carts', 'rename an asset', 'write carts'],
      actions: [
        { id: 'cartbuilder.open', name: 'Open Demo Project…', text: 'Needs Chrome or Edge. Use a writable working copy outside protected folders such as AppData. After a restart, Reconnect asks permission again.', detail: 'Choose the folder that contains demo/ (a demoframe project) or a flat folder with main.p8. Nothing is written until you press Write Carts.' },
        { id: 'cartbuilder.adopt', name: 'Adopt', text: 'Turns literal reload() calls of data carts into parts with --@data comments.' },
        { id: 'cartbuilder.stages', name: 'Workflow strip', text: 'Analyze (read-only) → Plan (place every part) → Validate (checks, errors block writing) → Commit (preview, confirm, verified write). Opening a folder only reads; adopting a project writes anchors and assets, and lists those files first.' },
        { id: 'cartbuilder.move', name: 'Move…', text: 'Every part has a Move… button: choose its cart, a new cart or "not placed" without dragging. Nothing is written until Write Carts.' },
        { id: 'cartbuilder.pack', name: 'Auto-pack', text: 'Drag parts between carts (0x4300 bytes each) or auto-pack with a best-fit heuristic; parts in the same group stay together.', detail: 'Auto-pack only rearranges the plan in memory; files change when you write.' },
        { id: 'cartbuilder.write', name: 'Write Carts', text: 'Parses the built carts in memory, then lists every file it will add, change, remove or move to demo/unused/ (with counts and unresolved references) and writes only after you confirm: the data carts (checked byte for byte) and the rewritten --@data anchor lines. Cancel writes nothing and keeps your arrangement. Success is shown only after the write was verified; failures are explained and recoverable.' },
      ],
      controls: [], shortcuts: [],
      restrictions: ['Needs the browser folder-access API (Chrome / Edge).', 'Only one write at a time; an interrupted write must be recovered before new writes.', 'See docs/PROJECT_MODEL.md.'],
      related: ['datacarts', 'audit', 'map', 'project-context'], keywords: ['anchor', 'reload', 'suite.json', 'demoframe', 'write'], legacy: 'doc-cartbuilder',
    },
    {
      id: 'extras', kind: 'tool', ws: 'extras', title: 'Extra Tools', rev: 1,
      summary: 'Smaller tools behind one tab bar: LUT Creator, Wave Designer, Line Tool and Terrain Lab.',
      inputs: ['OBJ models', 'heightmaps and images', 'Library images and palettes'],
      outputs: ['.p8 data carts', 'Lua tables', 'Picotron POD', 'waves.p8', 'Library images'],
      tasks: ['make motion paths', 'make 3D ball formations', 'design waveforms', 'draw vector lines as Lua', 'generate seamless terrain'],
      actions: [
        { id: 'extras.lut', name: 'LUT Creator', text: '2D motion paths and 3D ball formations exported as Lua, POD or a data cart.' },
        { id: 'extras.wave', name: 'Wave Designer', text: '16 scope waveforms; Export waves.p8 (Ctrl+E).' },
        { id: 'extras.line', name: 'Line Tool', text: 'Lines on a 128×128 canvas exported as Lua (Shift: 45° steps).' },
        { id: 'extras.terrain', name: 'Terrain Lab', text: 'Seamless terrain from noise or a heightmap with brushes, stamps, erosion and a 128×128 PICO-8 color map. The preview answers at once; the final render follows when you pause.' },
      ],
      controls: [{ id: 'extras.panel', label: 'Side panel splitter', text: 'Drag the splitter left of the controls, or focus it and use the arrow keys (Shift = larger steps, Home / End, Enter hides or shows the panel, 0 or double-click resets). On narrow screens the panel stacks below the canvas instead.' },
        { id: 'extras.terrain.preview', label: 'Terrain preview / final', text: 'The badge above the map says what you are looking at: Queued (your edit is acknowledged, the image shown is stale), Preview (fast low-resolution result of your latest edit), Preview · rendering final…, Final (full resolution, the only state exports use) or Render failed (Error ID and Retry). No percentages are shown because the renderer reports no progress.' }],
      shortcuts: [['Alt+1…4', 'Switch Extra Tools tab'], ['Ctrl+E', 'Export waves.p8 (Wave Designer)'], ['[ ]', 'Terrain brush size']],
      restrictions: ['Settings are kept in this browser only.'],
      related: ['palette', 'studio', 'library'], keywords: ['terrain', 'lut', 'wave', 'line', 'heightmap', 'erosion', 'pod'], legacy: 'doc-extras',
    },

    // ---- guides and reference ------------------------------------------------------------
    {
      id: 'suite', kind: 'guide', title: 'The Suite', rev: 1,
      summary: 'What the Suite is, how tools share work, and how to run it offline.',
      inputs: [], outputs: [],
      tasks: ['switch tools', 'run the Suite offline', 'understand what is stored in the browser'],
      actions: [
        { id: 'suite.offline', name: 'Offline use', text: 'The Suite is plain HTML/JS: open index.html from disk or a static host. No account, server or network is needed; only Report a problem → GitHub needs a connection.' },
        { id: 'suite.backup', name: 'Backup limits', text: 'Library → Export Library Backup covers saved assets. It does not include tool working sessions or files in project folders.' },
      ],
      controls: [], shortcuts: [],
      restrictions: ['Everything lives in this browser and origin; clearing site data erases it.'],
      related: ['library', 'settings', 'report-problem'], keywords: ['offline', 'backup', 'storage', 'indexeddb'], legacy: 'doc-suite',
    },
    {
      id: 'library', kind: 'guide', title: 'Library and Send to / Open in', rev: 1,
      summary: 'The shared asset store (images, palettes, maps) used by all tools.',
      inputs: ['assets saved from any tool'], outputs: ['Open in… another tool', 'PNG downloads', 'backup files'],
      tasks: ['open an image in another tool', 'rename or delete an asset', 'back up the Library'],
      actions: [{ id: 'library.open', name: 'Send to / Open in', text: 'Click an asset for Send to / Open in, rename, duplicate, PNG download and delete. Every destination is listed; an unavailable one stays focusable and shows exactly why (wrong asset type, size limit). A destination with unsaved work asks Replace or Cancel; cancelling keeps both. Deleting asks first.' }],
      controls: [{ id: 'library.button', label: 'Library button', text: 'Opens the shared asset drawer.' }], shortcuts: [],
      restrictions: ['A Library asset is not a file in a project folder.'],
      related: ['suite', 'studio', 'map'], keywords: ['assets', 'send to', 'open in', 'transfer', 'import'], legacy: 'doc-suite',
    },
    {
      id: 'project-context', kind: 'guide', title: 'Active project', rev: 1,
      summary: 'The app bar names the active project folder and whether the browser still allows access. It never means "saved".',
      inputs: [], outputs: [],
      tasks: ['reconnect a project folder', 'understand access states'],
      actions: [{ id: 'project-context.states', name: 'Access states', text: 'Reconnect needed, access denied, folder unavailable or name only. Reconnect in the tool that owns the project.' }],
      controls: [{ id: 'project-context.indicator', label: 'Project indicator', text: 'Shows "Project: name" and its access state.' }], shortcuts: [],
      restrictions: ['Permission is rechecked before use; a remembered folder returns as "reconnect needed".'],
      related: ['cartbuilder', 'audit', 'code'], keywords: ['permission', 'folder', 'reconnect', 'handle'], legacy: 'doc-cartbuilder',
    },
    {
      id: 'shortcuts', kind: 'reference', title: 'Keyboard shortcuts', rev: 1,
      summary: 'Shortcuts shared by all workspaces; tool-specific ones are listed in each tool’s topic.',
      inputs: [], outputs: [], tasks: ['navigate with the keyboard'],
      actions: [], controls: [],
      shortcuts: [['F1', 'Help for the current workspace'], ['Ctrl+K', 'Go to tool: search all workspaces'], ['Tab / Shift+Tab', 'Move between controls (option groups are one stop)'], ['Arrow keys / Home / End', 'Change the selected option in a group'], ['Enter / Space', 'Activate a button'], ['Esc', 'Close a dialog; focus returns to its opener']],
      restrictions: [], related: ['settings'], keywords: ['keys', 'hotkeys', 'keyboard', 'accessibility'], legacy: 'doc-keys',
    },
    {
      id: 'formats', kind: 'reference', title: 'File formats', rev: 1,
      summary: 'Formats the Suite reads and writes.',
      inputs: ['.p8', '.lua', 'PNG', 'OBJ'], outputs: ['.p8', 'PNG', 'JSON', 'CSV'], tasks: ['know what a tool can open'],
      actions: [], controls: [], shortcuts: [], restrictions: ['PICO-8 memory layout, nibble order and palette slots are preserved.'],
      related: ['suite'], keywords: ['p8', 'png', 'json', 'csv', 'format'], legacy: 'doc-formats',
    },
    {
      id: 'settings', kind: 'reference', title: 'Settings', rev: 1,
      summary: 'Help › Settings… changes help detail, tour offers, compact navigation and motion; kept in this browser only.',
      inputs: [], outputs: [], tasks: ['turn optional help off', 'reduce motion'],
      actions: [], controls: [{ id: 'settings.helpLevel', label: 'Help detail', text: 'Off, Concise or Detailed optional hints. Labels, warnings and errors are always shown.' }], shortcuts: [],
      restrictions: ['If the browser blocks storage, changes last until reload.'], related: ['suite'], keywords: ['preferences', 'theme', 'motion', 'help level'], legacy: 'doc-settings',
    },
    {
      id: 'report-problem', kind: 'guide', title: 'Report a problem', rev: 2,
      summary: 'Help › Report a problem… builds an editable summary from your text and sanitized error summaries.',
      inputs: [], outputs: ['copied summary', 'diagnostics JSON'], tasks: ['report a bug', 'export diagnostics'],
      actions: [], controls: [], shortcuts: [],
      restrictions: ['Nothing is sent automatically. Diagnostics do not read your project or storage. By default, exported error messages keep only generic error words (other words appear as […]), error types are standard names or OtherError and stacks list only the Suite’s own script lines; “Include full error details” adds scrubbed messages, error names and stack function names that may contain private details, so review both previews before exporting. Logs are lost when the tab closes; a crashed tab cannot be captured.'],
      related: ['suite'], keywords: ['bug', 'error', 'diagnostics', 'github', 'crash'], legacy: 'doc-web',
    },
  ];

  // old control/topic id -> current id, kept when something is renamed
  const ALIASES = {};

  return { TOPICS, ALIASES };
})();

if (typeof module !== 'undefined') module.exports = P8HelpData;
