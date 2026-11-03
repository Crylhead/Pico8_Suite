// js/tours-data.js
// Built-in quick tours (#61). Tool authors may also call P8Tours.register(tour); a tool without a
// tour is fine for external plugins. Built-in coverage is checked by tests/docs-integrity.js.
// Targets are stable ids / classes / data-help-id values, never nth-child.
// Bump `major` only for a meaningful new capability (it offers "What's new"); copy edits keep it.
// A target hidden by default or built by JavaScript must declare `optional: true` / `conditional: true`
// (or a `before` step); tests/docs-integrity.js enforces this.
// Steps tag areas: work, controls, input, output, handoff. Justified areaExceptions document
// non-editor overviews and tracked follow-up gaps without pretending those areas are covered.
// Help text may come from the help registry via helpId (js/help-data.js).

'use strict';

const P8TourData = (() => {
  const TOURS = [
    {
      id: 'suite', title: 'Suite overview', major: 1, ws: 'home', scope: 'suite',
      summary: 'Where the tools are, how the Library connects them and where to find help.',
      steps: [
        { id: 'welcome', title: 'Welcome', text: 'The Suite is a set of PICO-8 tools in one page. Everything stays in this browser; nothing is uploaded. This tour takes about a minute and changes nothing.' },
        { id: 'workspaces', target: '#wsTabs', title: 'Workspaces', text: 'Each icon opens one tool: Pixel Studio, Palette & Fades, Tile Maker, Map Editor, Code Editor and the project tools. Arrow keys move between them. Each tool keeps its work while you switch.' },
        { id: 'library', target: '#libraryBtn', title: 'Library', text: 'The shared place for images, palettes and maps. Save from one tool, then use Open in… to continue in another.' },
        { id: 'project', optional: true, target: '#projectIndicator', title: 'Active project', text: 'When a project folder is open, its name and whether the browser still allows access appear here. It never means a file was saved.' },
        { id: 'help', target: '#menubar', title: 'Help and settings', text: 'F1 opens searchable help for the tool you are in. Help › Settings turns optional hints off; Help › Report a problem prepares a bug report you review first.' },
      ],
    },
    {
      id: 'studio', title: 'Pixel Studio basics', major: 1, ws: 'studio',
      summary: 'Canvas, palette slots, and how a drawing reaches the Library.',
      areaExceptions: { input: 'Import/selection orientation is tracked in #105; the current basics tour starts with a canvas.' },
      steps: [
        { id: 'tools', areas: ['controls'], before: { ws: 'studio' }, target: '#psTools', title: 'Drawing tools', text: 'Pencil, shapes, fill, selection and more. Buttons with a small triangle hold more tools; hover, right-click or long-press them.' },
        { id: 'canvas', areas: ['work'], target: '#psCanvas', title: 'Canvas', text: 'Left button paints with the primary color, right button with the secondary. The canvas can be 1×1 up to 1024×1024.' },
        { id: 'preview', target: '#psPreviewScale', helpId: 'studio.preview', title: 'Preview scale' },
        { id: 'palette', areas: ['controls'], target: '#psPalette', title: 'Palette slots', text: 'Sixteen slots, each showing one of the 32 PICO-8 colors. Double-click a slot to remap it; slots are what exports keep.' },
        { id: 'transparent', target: '[data-help-id="studio.transparent"]', helpId: 'studio.transparent', title: 'Transparent slot' },
        { id: 'tiled', target: '[data-help-id="studio.tiled"]', helpId: 'studio.tiled', title: 'Tiled view' },
        { id: 'save', areas: ['output', 'handoff'], target: '#libraryBtn', title: 'Keep your work', text: 'File › Save to Library (Ctrl+S) makes the image available to the other tools. Your working image is also autosaved in this browser, which is not a backup.' },
      ],
    },
    {
      id: 'palette', title: 'Palette & Fades tour', major: 1, ws: 'palette',
      summary: 'Build a 16-color screen palette, fill dark and bright fade ramps, preview them and export Lua.',
      steps: [
        { id: 'system', areas: ['input'], before: { ws: 'palette' }, target: '.card-system', title: 'System palette', text: 'All 32 PICO-8 colors: the base colors 0–15 and the extra colors 128–143. Drag a color (or tap it) into one of the 16 custom slots.' },
        { id: 'slots', areas: ['work', 'controls'], target: '#paletteSlots', title: 'Custom palette', text: 'Your 16 screen colors. Drag slots onto each other to reorder; right-click or long-press clears one. Empty slots count as black in previews.' },
        { id: 'mode', target: '#modeSeg', title: 'Normal and Ramp mode', text: 'Normal picks palette colors. Ramp edits and saves ramp presets, which Auto Fill uses to propose fade stops.' },
        { id: 'fade', target: '.card-fade', title: 'Fade generator', text: 'Choose Dark or Bright, drop a palette color on Fade to, then fill each color’s row of stops by dropping colors or pressing Auto Fill. Each direction keeps its own stops and target.' },
        { id: 'preview', target: '#gradientCanvas', title: 'Previews', text: 'The gradient shows all 16 colors fading over 32 dithered steps. Load Preview PNG… shows your own image through the palette; gamma and coverage tune the dithering.' },
        { id: 'slider', target: '#fadeSlider', title: 'Fade slider', text: 'Runs from darkest (left) through normal to brightest (right). Arrow keys move it when it has focus.' },
        { id: 'files', areas: ['output', 'handoff'], target: '#menubar', title: 'Save, export and hand off', text: 'File › Save Project downloads a .p8pal preset; your work is also autosaved in this browser, which is not a backup. Export offers Palette (Lua), .gpl, Fades (.png) and the Two-Sided Fade Lua table. Export › Custom Palette → Library… shares the palette with Pixel Studio, Tile Maker and the Map Editor.' },
      ],
    },
    {
      id: 'tiles', title: 'Tile Maker tour', major: 1, ws: 'tiles',
      summary: 'Turn a picture into 8×8 PICO-8 tiles, check the 256-tile budget and send tiles and map onward.',
      steps: [
        { id: 'import', areas: ['input', 'controls'], before: { ws: 'tiles' }, target: '.tm-bar', title: 'Import and conversion', text: 'Import Image…, From Library… or drop a picture on the Original view. Color conversion and Dither decide how it becomes 16 colors. Open… and Save… keep a tile project as a file.' },
        { id: 'reduce', target: '#tmThreshold', title: 'Tile reduction', text: 'PICO-8 holds at most 256 tiles. Raise the threshold and press Rebuild to merge similar tiles until the picture fits. Higher values lose more detail.' },
        { id: 'views', areas: ['work'], target: '.tm-views', title: 'Original, result and tileset', text: 'Compare the original with the reconstruction from tiles; the tileset on the right shows every unique tile. Zoom buttons and Show tile selection help you find a tile in the picture.' },
        { id: 'viewport', target: '#tmViewSeg', helpId: 'tiles.viewport', title: 'Viewport heatmap' },
        { id: 'stats', target: '.tm-stats', title: 'Stats and warnings', text: 'PICO-8 compatible, unique tiles, reconstruction error and the viewport size used for the heatmap. Warnings below explain what still exceeds a PICO-8 limit.' },
        { id: 'edit', target: '#tmEditTiles', title: 'Refine tiles', text: 'After a build, Auto Generate Tiles re-derives each tile from all of its uses, and Edit Tiles… opens a pixel editor for single tiles; Save Changes there applies them.' },
        { id: 'export', areas: ['output', 'handoff'], target: '.tm-bar [data-action="tiles-export-p8"]', title: 'Export and hand off', text: 'Export to PICO-8… writes tiles and map as a .p8. The Export menu adds PNG and Aseprite output and Tiles + Map → Map Editor, which opens a temporary copy there and asks before replacing unsaved Map Editor work.' },
      ],
    },
    {
      id: 'map', title: 'Map Editor tour', major: 1, ws: 'map',
      summary: 'Paint PICO-8 maps with tiles from a sprite sheet, check where the map fits and save it.',
      steps: [
        { id: 'tools', before: { ws: 'map' }, target: '#meTools', title: 'Map tools', text: 'Draw, rectangle fill, flood fill, pick, select and pan. Each tool’s tooltip shows its key, for example B for Draw and H for Pan.' },
        { id: 'name', target: '#meName', title: 'Name and save status', text: 'The map name, followed by its save badge and where it fits in a cart. The badge says “Saved” only after the browser confirmed the write; click it for details.' },
        { id: 'size', areas: ['controls'], target: '.layout-map [data-action="map-resize"]', helpId: 'map.sizes', title: 'Map size' },
        { id: 'canvas', areas: ['work'], target: '#meStage', title: 'Map canvas', text: 'Paint with the current brush. Grid shows 8×8 cells and Screens shows 128×128 screens; Numbers shows tile numbers when zoomed in. The status line below names the cell and tile under the pointer.' },
        { id: 'sheet', areas: ['input'], target: '#meSheet', title: 'Tileset', text: 'Click a tile, or drag across several, to make a brush. File › Tileset from Library or from .p8 changes the sheet; Reload reads a Library image again after you edited it in Pixel Studio.' },
        { id: 'brush', target: '#meBrush', title: 'Brush', text: 'The tiles you will paint. Edit › Copy as Brush turns a selection of the map into a brush.' },
        { id: 'files', areas: ['output', 'handoff'], target: '#menubar', title: 'Save, export and hand off', text: 'File › Save to Library keeps the map for other tools. Export creates a new .p8 cart, or writes only the map (optionally the sprites) into an existing .p8. Tile Maker and the Code Editor can open their maps here.' },
      ],
    },
    {
      id: 'code', title: 'Code Editor tour', major: 1, ws: 'code',
      summary: 'Edit PICO-8 Lua with tabs, token counts, includes and an optional local Run helper.',
      steps: [
        { id: 'editor', areas: ['work'], before: { ws: 'code' }, target: '#ceEditor', title: 'Editor', text: 'Edits the __lua__ section of a .p8 cart or a .lua file, with PICO-8 syntax colors and completion. Ctrl+click an #include line to open that file.' },
        { id: 'tabs', target: '#ceTabs', optional: true, helpId: 'code.tabs', title: 'Code tabs' },
        { id: 'save', target: '#ceSave', helpId: 'code.save', title: 'Save' },
        { id: 'run', areas: ['controls'], target: '#ceRun', title: 'Run in PICO-8', text: 'Run saves and starts the cart in your own PICO-8 through the optional local helper tools/run_pico8_bridge.bat (needs Python). The browser itself cannot start programs; printh() output appears below the code.' },
        { id: 'meters', target: '#ceTokens', optional: true, helpId: 'code.tokens', title: 'Token and character meters' },
        { id: 'files', areas: ['input'], target: '.ce-files-panel', title: 'Files', text: 'File › Open Folder… lists the carts of a project folder. It needs Chrome or Edge, and the browser asks you to allow access to that folder.' },
        { id: 'outline', target: '.ce-outline-panel', title: 'Functions', text: 'Every function in the open file; filter the list with Ctrl+Shift+O and click a name to jump to it.' },
        { id: 'handoff', areas: ['output', 'handoff'], target: '#ceGfxBtn', title: 'Hand off', text: 'Sprites → Pixel Studio and Map → Map Editor open this cart’s graphics and map. Cart › Minify… copies the current code to the Minifier without saving it.' },
      ],
    },
    {
      id: 'minifier', title: 'Minifier workspace', major: 1, ws: 'minifier',
      summary: 'Source, optimization options, code comparison, metrics, diagnostics and separate build exports.',
      steps: [
        { id: 'source', areas: ['input'], before: { ws: 'minifier' }, target: '#mnSourceActions', title: 'Source', text: 'Open a .p8 or .lua file, paste Lua, or capture the current Code Editor buffer. The name and provenance identify this page-only snapshot. Replacing it asks first; nothing is saved or optimized by this tour.' },
        { id: 'options', areas: ['controls'], target: '#mnProfile', title: 'Optimization options', text: 'This area selects the optimization policy: Minimal + Tokens is the supported default. Minimal keeps names and line breaks, but can change expressions, comments and spacing. Savings are not guaranteed. Optimize runs explicitly; Cancel stops work and Retry reloads the engine.' },
        { id: 'compare', areas: ['work'], target: '#mnCompareMode', title: 'Compare', helpId: 'minifier.view' },
        { id: 'output', target: '#mnOutputPane', optional: true, title: 'Generated output', helpId: 'minifier.output' },
        { id: 'metrics', target: '#mnMetricsHeading', title: 'Metrics', helpId: 'minifier.metrics' },
        { id: 'diagnostics', target: '#mnDiagnosticsSummary', title: 'Diagnostics', text: 'Expand this area to read engine messages and filter their severity. Reliable location buttons select a line in the current original snapshot. Unknown or stale locations cannot navigate. Errors and recovery feedback remain visible when optional hints are off.' },
        { id: 'export', areas: ['output', 'handoff'], target: '#mnExportActions', title: 'Export', text: 'Copy optimized Lua or download a separate .min.lua / .min.p8 build copy after a successful current result passes validation. Disabled actions explain what is missing below. Preservation checks are separate from budget compliance and runtime testing. Warnings give exact code-budget excesses; over-budget .p8 output requires the debugging-only choice. Original header and non-Lua cartridge data are preserved. Keep the editable project: source-only directives may change or disappear. The download dialog also offers .p8.png when its local encoder is ready; its code capacity is checked separately.' },
        { id: 'editor', target: '#mnReturn', optional: true, title: 'Code Editor handoff', helpId: 'minifier.editor' },
      ],
    },
    {
      id: 'cartbuilder', title: 'Cart Builder tour', major: 1, ws: 'cartbuilder',
      summary: 'Pack a demo project’s data into data carts, validate the plan and write it with --@data anchors.',
      steps: [
        { id: 'open', areas: ['input'], before: { ws: 'cartbuilder' }, target: '#cbOpen', title: 'Project folder', text: 'Opens a demo project folder. It needs Chrome or Edge, and a writable working copy outside protected folders such as AppData. Opening only reads; after a restart, Reconnect asks for permission again.' },
        { id: 'add', target: '#cbAddLib', title: 'Add parts', text: 'Add images or maps from the Library, or any file, as parts. Each part becomes data in a cart that the code finds through its --@data anchor.' },
        { id: 'parts', areas: ['work'], target: '#cbParts', title: 'Parts', text: 'Every part with its size and group. Each part has a Move… button to choose its cart without dragging.' },
        { id: 'stages', target: '#cbStages', optional: true, helpId: 'cartbuilder.stages', title: 'Workflow stages' },
        { id: 'pack', areas: ['controls'], target: '#cbPack', helpId: 'cartbuilder.pack', title: 'Carts and Auto-pack' },
        { id: 'report', target: '#cbReport', optional: true, title: 'Validation report', text: 'Checks for the current plan. Errors block writing and stay visible even when optional hints are off.' },
        { id: 'write', areas: ['output', 'handoff'], target: '#cbWrite', helpId: 'cartbuilder.write', title: 'Write Carts' },
      ],
    },
    {
      id: 'audit', title: 'Project Audit tour', major: 1, ws: 'audit',
      summary: 'Scan a project folder for tokens and characters per cart, references and unused carts.',
      steps: [
        { id: 'open', areas: ['input'], before: { ws: 'audit' }, target: '#auOpen', title: 'Choose a folder', text: 'Choose a project folder or drop it on this page. The browser asks which folder to read; every .p8 in it and its subfolders is read locally and nothing is uploaded. Rescan (F5) reads it again.' },
        { id: 'table', areas: ['work'], target: '.au-main', title: 'Carts table', text: 'One row per cart with tokens and characters, including #include files. Click a header to sort; Ctrl+F filters the carts.' },
        { id: 'columns', areas: ['controls'], target: '#auCols', helpId: 'audit.columns', title: 'Columns' },
        { id: 'details', target: '.au-side', title: 'Details', text: 'Cart shows details for the selected cart; Project summary shows which carts are used and which nothing points to. Copy puts the view on the clipboard as plain text.' },
        { id: 'export', areas: ['output', 'handoff'], target: '#auCsv', title: 'Export and hand off', text: 'Export CSV or JSON saves the scan as a download. Data Carts and Cart Builder work with the same project folder.' },
      ],
    },
    {
      id: 'datacarts', title: 'Data Carts tour', major: 1, ws: 'datacarts',
      summary: 'See what each data cart holds and which ranges the code reloads, then pack new data carts.',
      steps: [
        { id: 'open', areas: ['input'], before: { ws: 'datacarts' }, target: '#dcOpen', title: 'Open carts', text: 'Open Project Folder… (the same folder as Project Audit) or Open .p8 Files… reads carts locally in this browser.' },
        { id: 'mode', areas: ['controls'], target: '#dcMode', title: 'Inspect and Pack', text: 'Inspect shows existing carts. Pack builds a new data cart (17,152 bytes) from ranges, images and files, checks the cart text before the download and writes the reload() lines for you.' },
        { id: 'list', target: '[data-ws="datacarts"] .dc-side', title: 'Cart list', text: 'The carts found. Only data carts hides carts that hold code.' },
        { id: 'map', areas: ['work'], target: '#dcMap', optional: true, helpId: 'datacarts.map', title: 'Memory map' },
        { id: 'viewer', target: '#dcViewer', optional: true, helpId: 'datacarts.view', title: 'Range viewer' },
        { id: 'output', areas: ['output', 'handoff'], target: '#dcToLib', optional: true, title: 'Use the data', text: 'Send an image to the Library, add the range to a pack or download the raw bytes as .bin.' },
      ],
    },
    {
      id: 'data', title: 'Data Tools tour', major: 1, ws: 'data',
      summary: 'Convert files, text and images into PICO-8 strings and split greyscale images into nibbles.',
      steps: [
        { id: 'string', areas: ['input'], before: { ws: 'data' }, target: '#bdCard', title: 'Binary → PICO-8 string', text: 'Turns a file, text or a Library image into a Lua string literal; non-printable bytes become \\ddd escapes.' },
        { id: 'mode', areas: ['controls'], target: '#bdMode', title: 'Input mode', text: 'File, text or image. Images are packed in PICO-8 memory order or one byte per pixel, depending on the layout you choose.' },
        { id: 'output', areas: ['work', 'output', 'handoff'], target: '#bdOut', title: 'Generated code', text: 'Convert fills this with Lua using your variable name. Copy to clipboard or Download .lua; nothing is written into your carts.' },
        { id: 'nibble', target: '#nbCard', helpId: 'data.nibble', title: 'Nibble split' },
        { id: 'nibble-out', target: '#nbActions', optional: true, title: 'Nibble results', text: 'Send the high and low images, or both stacked, to the Library, or download them as PNG.' },
      ],
    },
    {
      id: 'extras', title: 'Extra Tools overview', major: 1, ws: 'extras',
      summary: 'The smaller tools behind one tab bar: LUT Creator, Wave Designer, Line Tool and Terrain Lab.',
      areaExceptions: { input: 'This overview routes to dedicated subtool tours for input.', output: 'Output formats are explained by each dedicated subtool tour.', handoff: 'Dedicated subtool tours explain their own export and Library handoffs.' },
      steps: [
        { id: 'tabs', areas: ['controls'], before: { ws: 'extras' }, target: '#exTabs', helpId: 'extras.tabs', title: 'Extra tools' },
        { id: 'desc', target: '#exDesc', title: 'What the tool does', text: 'A one-line description of the selected tool. Each tool keeps its settings in this browser while you switch.' },
        { id: 'body', areas: ['work'], target: '#exBody', title: 'Tool area', text: 'Preview on the left, controls on the right; on narrow screens the controls stack below. LUT Creator, Wave Designer, Line Tool and Terrain Lab each have their own tour in Help › Quick tours.' },
        { id: 'splitter', target: '[data-ws="extras"] .panel-splitter', optional: true, helpId: 'extras.panel', title: 'Panel splitter' },
      ],
    },
    {
      id: 'lut', title: 'LUT Creator tour', major: 1, ws: 'extras', sub: 'lut',
      summary: '2D motion paths and 3D ball formations exported as Lua, POD or a data cart.',
      steps: [
        { id: 'stage', areas: ['work', 'controls'], before: { ws: 'extras', click: '#exTabs [data-value="lut"]' }, target: '[data-ex="lut"] .ex-stage', title: 'Preview', text: 'Choose 2D motion paths or 3D ball formations, and the PICO-8 or Picotron aspect, above the preview. The preview animates the current result.' },
        { id: 'canvas', conditional: true, target: '[data-ex="lut"] .ex-lut-canvas', title: 'Edit the preview', text: 'In 2D the curve’s points shape the motion path. In 3D, Space animates the balls; the buttons below step frames and rotate the camera.' },
        { id: 'controls', areas: ['input', 'output', 'handoff'], conditional: true, target: '[data-ex="lut"] .ex-controls', helpId: 'extras.lut.workflow', title: 'Settings and export' },
      ],
    },
    {
      id: 'wave', title: 'Wave Designer tour', major: 1, ws: 'extras', sub: 'wave',
      summary: 'Mix and preview 16 scope waveforms, then export them as a PICO-8 data cart.',
      steps: [
        { id: 'top', areas: ['input'], before: { ws: 'extras', click: '#exTabs [data-value="wave"]' }, target: '[data-ex="wave"] .ex-wave-top', title: 'Presets and files', text: 'Pick a preset and name it; Randomize (Ctrl+R), Copy to next (Ctrl+D) and Reset change only that preset. Save… and Load… keep all 16 as a .json project.' },
        { id: 'strip', conditional: true, target: '[data-ex="wave"] .ex-wave-strip', title: 'All 16 waves', text: 'Click a thumbnail to edit that preset.' },
        { id: 'scopes', areas: ['work'], conditional: true, target: '[data-ex="wave"] .ex-wave-scopes', title: 'Scopes', text: 'The waveform over time and as an XY scope. Play and Speed animate the preview.' },
        { id: 'groups', areas: ['controls'], conditional: true, target: '[data-ex="wave"] .ex-wave-groups', title: 'Mix and processing', text: 'Mix, Oscillators and Post-processing shape the selected wave; every change shows in the scopes at once.' },
        { id: 'export', areas: ['output', 'handoff'], conditional: true, target: '[data-ex="wave"] .ex-wave-top', helpId: 'extras.wave.workflow', title: 'Export' },
      ],
    },
    {
      id: 'line', title: 'Line Tool tour', major: 1, ws: 'extras', sub: 'line',
      summary: 'Draw vector lines on a 128×128 canvas and export them as Lua.',
      steps: [
        { id: 'stage', areas: ['work', 'input'], before: { ws: 'extras', click: '#exTabs [data-value="line"]' }, target: '[data-ex="line"] .ex-stage', title: 'Canvas', text: 'Drag to draw a line; Shift snaps to 45° steps. The canvas is a 128×128 PICO-8 screen.' },
        { id: 'controls', areas: ['controls'], conditional: true, target: '[data-ex="line"] .ex-controls', title: 'Color, line and view', text: 'Pick the color and background, and a 1 px line or an array of parallel lines. View switches vector and pixel display; Trace library image… shows a Library picture underneath that is never exported. Undo is Ctrl+Z.' },
        { id: 'export', areas: ['output', 'handoff'], conditional: true, target: '[data-ex="line"] .ex-controls', helpId: 'extras.line.workflow', title: 'Export' },
      ],
    },
    {
      id: 'terrain', title: 'Terrain Lab basics', major: 1, ws: 'extras', sub: 'terrain',
      summary: 'Generate seamless terrain, paint it, and see what will be exported.',
      areaExceptions: { input: 'Import orientation is tracked in #105.', output: 'Final export and Library orientation are tracked in #105.', handoff: 'Safe output handoff orientation is tracked in #105.' },
      steps: [
        { id: 'open', areas: ['work'], before: { ws: 'extras', click: '#exTabs [data-value="terrain"]' }, target: '.tl-canvas', title: 'Terrain preview', text: 'The map wraps around its edges. The preview answers every edit at once; the full-resolution render follows when you pause, and exports use that final render.' },
        { id: 'simple', areas: ['controls'], conditional: true, target: '.tl-simple', title: 'Terrain settings', text: 'Choose a terrain type and shape it with a few sliders. Advanced adds every generation, erosion and light parameter.' },
        { id: 'brush', conditional: true, target: '.tl-brush', title: 'Brushes', text: 'Raise, lower, smooth and more. [ and ] change the brush size. Undo and History let you step back.' },
        { id: 'status', conditional: true, target: '.tl-statusbar', title: 'Status bar', text: 'Shows the current action and what is under the pointer, including the PICO-8 pixel and height level.' },
      ],
    },
  ];
  return { TOURS };
})();

if (typeof module !== 'undefined') module.exports = P8TourData;
