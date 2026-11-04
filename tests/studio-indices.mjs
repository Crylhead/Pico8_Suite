// Opt-in #181 regression; same existing browser configuration as geometry-smoke.mjs.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {serve,fixture} from './geometry-smoke.mjs';
const require=createRequire(import.meta.url), p=require(process.env.P8_GEOMETRY_PLAYWRIGHT||'playwright');
const {server,url}=await serve(process.cwd());
const browser=await p.chromium.launch({headless:true,executablePath:process.env.P8_GEOMETRY_BROWSER_EXECUTABLE,args:JSON.parse(process.env.P8_GEOMETRY_BROWSER_ARGS||'[]')});
try {
 const page=await browser.newPage({viewport:{width:1536,height:712},deviceScaleFactor:1.25,reducedMotion:'reduce'});
 await page.addInitScript(()=>localStorage.setItem('p8suite.uxPrefs',JSON.stringify({version:1,autoOfferTours:false,helpLevel:'off'})));
 await page.goto(url); await fixture(page);
 const documentData=()=>page.evaluate(()=>JSON.stringify(P8StudioDebug.state().doc));
 const original=await documentData();
 const button=page.locator('#toggleIndices');
 const check=async shown=>{
   assert.equal(await button.textContent(),'Indices'); // #197: fixed label; the state is aria-pressed
   assert.equal(await button.getAttribute('aria-pressed'),String(shown));
   const rows=await page.locator('#psPalette .ps-sw').evaluateAll(nodes=>nodes.map(n=>({slot:n.dataset.slot,name:n.getAttribute('aria-label'),hidden:n.querySelector('.ps-sw-n').hidden,color:n.style.background})));
   assert.equal(rows.length,16);
   for(const r of rows){assert.equal(r.hidden,!shown);assert.match(r.name,new RegExp(`^Slot ${r.slot}, color \\d+`));assert(r.color);}
   assert.equal(await documentData(),original);
 };
 for(const theme of ['light','dark']){
   await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;P8App.setWorkspace('studio');},theme);
   await check(true); await button.click(); await check(false);
   if(process.env.P8_INDICES_SCREENSHOTS) await page.screenshot({path:process.env.P8_INDICES_SCREENSHOTS+'/'+theme+'-studio-hidden.png'});
   await page.locator('#psPalette .ps-sw').first().focus();
   await page.evaluate(()=>document.querySelector('#toggleIndices').click()); await check(true);
   assert.equal(await page.evaluate(()=>document.activeElement.dataset.slot),'0');
   await button.focus(); await page.keyboard.press('Space'); await check(false);
   for(const ws of ['palette','tiles','studio']){
     await page.evaluate(ws=>P8App.setWorkspace(ws),ws); assert(await button.isVisible()); await check(false);
   }
   await button.press('Enter'); await check(true);
 }
 await button.click(); await check(false);
 await page.reload(); await page.waitForFunction(original=>window.P8StudioDebug&&JSON.stringify(P8StudioDebug.state().doc)===original,original);
 await page.evaluate(()=>P8App.setWorkspace('studio')); await check(false);
 assert.equal(await page.evaluate(()=>P8App.store.get('p8pal.showIndices',true)),false);
 await button.press('Space'); await check(true);
 console.log('Studio indices: mouse/keyboard, both themes, cross-tool synchronization, focus, accessible names, reload and unchanged image/palette passed.');
} finally {await browser.close();await new Promise(r=>server.close(r));}
