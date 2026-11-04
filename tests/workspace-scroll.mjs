// Opt-in interaction regression for #180; uses an existing Playwright installation.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {serve, fixture} from './geometry-smoke.mjs';
const require=createRequire(import.meta.url), p=require(process.env.P8_GEOMETRY_PLAYWRIGHT||'playwright');
const {server,url}=await serve(process.cwd());
const browser=await p.chromium.launch({headless:true,executablePath:process.env.P8_GEOMETRY_BROWSER_EXECUTABLE,args:JSON.parse(process.env.P8_GEOMETRY_BROWSER_ARGS||'[]')});
try {
 const page=await browser.newPage({viewport:{width:1536,height:712},deviceScaleFactor:1.25,reducedMotion:'reduce'});
 await page.addInitScript(()=>localStorage.setItem('p8suite.uxPrefs',JSON.stringify({version:1,autoOfferTours:false,helpLevel:'off'})));
 await page.goto(url); const original=await fixture(page);
 const view=async(ws,sub)=>{await page.evaluate(({ws,sub})=>P8App.setWorkspace(ws,{sub}),{ws,sub}); await page.waitForTimeout(100);};
 const top=()=>page.locator('#workspaceHost').evaluate(n=>n.scrollTop);
 const scroll=async y=>page.locator('#workspaceHost').evaluate((n,y)=>n.scrollTop=y,y);
 await view('palette'); await scroll(130); const palette=await top(); assert(palette>0);
 const chrome=await page.locator('.appbar').boundingBox();
 await view('tiles'); assert.equal(await top(),0); await scroll(350); const tiles=await top(); assert(tiles>0);
 await view('palette'); assert.equal(await top(),palette);
 await view('tiles'); assert.equal(await top(),tiles);
 await page.locator('#wsFind').focus(); await page.keyboard.press('PageDown'); assert((await top())>tiles);
 assert.equal(await page.evaluate(()=>document.activeElement.id),'workspaceHost');
 assert.deepEqual(await page.locator('.appbar').boundingBox(),chrome);
 assert.equal(await page.evaluate(()=>scrollY),0);
 await page.setViewportSize({width:360,height:900});
 await view('extras','wave'); await scroll(180); const wave=await top(); assert(wave>0);
 await view('extras','line'); assert.equal(await top(),0); await scroll(90); const line=await top();
 await view('extras','wave'); assert.equal(await top(),wave);
 await view('studio'); await view('extras'); assert.equal(await top(),wave);
 await page.evaluate(()=>document.querySelector('#exTabs [data-value="line"]').click()); assert.equal(await top(),line);
 await page.evaluate(()=>document.querySelector('#exTabs [data-value="wave"]').click()); assert.equal(await top(),wave);
 const unchanged=await page.evaluate(()=>JSON.stringify({code:document.querySelector('#ceText').value,studio:P8StudioDebug.state().doc,minifier:Suite.minifier.getInput().source}));
 assert.equal(unchanged,original);
 console.log('Workspace host: keyboard paging, per-tool/subtool restoration, fixed chrome and unchanged documents passed.');
} finally {await browser.close();await new Promise(r=>server.close(r));}
