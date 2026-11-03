// js/tours-data.js
// Built-in quick tours (#61). Tool authors may also call P8Tours.register(tour); a tool without a
// tour is fine. Targets are stable ids / classes / data-help-id values, never nth-child.
// Bump `major` only for a meaningful new capability (it offers "What's new"); copy edits keep it.
// A target hidden by default or built by JavaScript must declare `optional: true` / `conditional: true`
// (or a `before` step); tests/docs-integrity.js enforces this.
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
      steps: [
        { id: 'tools', before: { ws: 'studio' }, target: '#psTools', title: 'Drawing tools', text: 'Pencil, shapes, fill, selection and more. Buttons with a small triangle hold more tools; hover, right-click or long-press them.' },
        { id: 'canvas', target: '#psCanvas', title: 'Canvas', text: 'Left button paints with the primary color, right button with the secondary. The canvas can be 1×1 up to 1024×1024.' },
        { id: 'preview', target: '#psPreviewScale', helpId: 'studio.preview', title: 'Preview scale' },
        { id: 'palette', target: '#psPalette', title: 'Palette slots', text: 'Sixteen slots, each showing one of the 32 PICO-8 colors. Double-click a slot to remap it; slots are what exports keep.' },
        { id: 'transparent', target: '[data-help-id="studio.transparent"]', helpId: 'studio.transparent', title: 'Transparent slot' },
        { id: 'tiled', target: '[data-help-id="studio.tiled"]', helpId: 'studio.tiled', title: 'Tiled view' },
        { id: 'save', target: '#libraryBtn', title: 'Keep your work', text: 'File › Save to Library (Ctrl+S) makes the image available to the other tools. Your working image is also autosaved in this browser, which is not a backup.' },
      ],
    },
    {
      id: 'minifier', title: 'Minifier workspace', major: 1, ws: 'minifier',
      summary: 'Source, optimization options, code comparison, metrics, diagnostics and separate build exports.',
      steps: [
        { id: 'source', before: { ws: 'minifier' }, target: '#mnSourceActions', title: 'Source', text: 'Open a .p8 or .lua file, paste Lua, or capture the current Code Editor buffer. The name and provenance identify this page-only snapshot. Replacing it asks first; nothing is saved or optimized by this tour.' },
        { id: 'options', target: '#mnProfile', title: 'Optimization options', text: 'This area selects the optimization policy: Minimal + Tokens is the supported default. Minimal keeps names and line breaks, but can change expressions, comments and spacing. Savings are not guaranteed. Optimize runs explicitly; Cancel stops work and Retry reloads the engine.' },
        { id: 'compare', target: '#mnCompareMode', title: 'Compare', helpId: 'minifier.view' },
        { id: 'output', target: '#mnOutputPane', optional: true, title: 'Generated output', helpId: 'minifier.output' },
        { id: 'metrics', target: '#mnMetricsHeading', title: 'Metrics', helpId: 'minifier.metrics' },
        { id: 'diagnostics', target: '#mnDiagnosticsSummary', title: 'Diagnostics', text: 'Expand this area to read engine messages and filter their severity. Reliable location buttons select a line in the current original snapshot. Unknown or stale locations cannot navigate. Errors and recovery feedback remain visible when optional hints are off.' },
        { id: 'export', target: '#mnExportActions', title: 'Export', text: 'Copy optimized Lua or download a separate .min.lua / .min.p8 build copy after a successful current result passes validation. Disabled actions explain what is missing below. Preservation checks are separate from budget compliance and runtime testing. Warnings give exact code-budget excesses; over-budget .p8 output requires the debugging-only choice. Original header and non-Lua cartridge data are preserved. Keep the editable project: source-only directives may change or disappear. The download dialog also offers .p8.png when its local encoder is ready; its code capacity is checked separately.' },
        { id: 'editor', target: '#mnReturn', optional: true, title: 'Code Editor handoff', helpId: 'minifier.editor' },
      ],
    },
    {
      id: 'terrain', title: 'Terrain Lab basics', major: 1, ws: 'extras', sub: 'terrain',
      summary: 'Generate seamless terrain, paint it, and see what will be exported.',
      steps: [
        { id: 'open', before: { ws: 'extras', click: '#exTabs [data-value="terrain"]' }, target: '.tl-canvas', title: 'Terrain preview', text: 'The map wraps around its edges. The preview answers every edit at once; the full-resolution render follows when you pause, and exports use that final render.' },
        { id: 'simple', conditional: true, target: '.tl-simple', title: 'Terrain settings', text: 'Choose a terrain type and shape it with a few sliders. Advanced adds every generation, erosion and light parameter.' },
        { id: 'brush', conditional: true, target: '.tl-brush', title: 'Brushes', text: 'Raise, lower, smooth and more. [ and ] change the brush size. Undo and History let you step back.' },
        { id: 'status', conditional: true, target: '.tl-statusbar', title: 'Status bar', text: 'Shows the current action and what is under the pointer, including the PICO-8 pixel and height level.' },
      ],
    },
  ];
  return { TOURS };
})();

if (typeof module !== 'undefined') module.exports = P8TourData;
