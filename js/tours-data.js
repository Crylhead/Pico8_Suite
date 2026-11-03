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
      id: 'suite', title: 'Suite overview', major: 1,
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
      id: 'studio', title: 'Pixel Studio basics', major: 1,
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
      id: 'terrain', title: 'Terrain Lab basics', major: 1,
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
