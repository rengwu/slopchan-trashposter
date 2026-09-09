import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const defaults = JSON.parse(readFileSync(new URL('../../internal/engine/defaults.json', import.meta.url), 'utf8'));
test('native bridge controls, keyboard clock, patch persistence, editor, token, transport and post link', async ({ page }) => {
 const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
 await page.addInitScript((defaults) => {
  const config = JSON.parse(localStorage.getItem('patch') || JSON.stringify(defaults));
  const state = {config,session:'test-session',active:false,nextAt:0,running:'',runs:[],availability:{agents:{codex:true,claude:true},spaces:{homebase:true}},presets:Object.fromEntries(defaults.agents.map(a=>[a.id,a]))};
  window.go = {main:{App:{
   State:async()=>structuredClone(state),
   Save:async c=>{state.config=structuredClone(c);state.config.hasToken=!!c.token;delete state.config.token;localStorage.setItem('patch',JSON.stringify(state.config));return structuredClone(state)},
   Start:async()=>{state.active=true;state.nextAt=Date.now()+10000},Stop:async()=>{state.active=false;state.running='';state.nextAt=0},
   Launch:async()=>{state.runs=[{id:'run',startedAt:Date.now(),status:'posted',postId:42,postUrl:'https://example.test/posts/42',agent:'Codex',space:'Home',path:'~',personality:'Cryptid',color:'#c5fa66',dryRun:true,log:'test output',text:'test post',error:''}]},
   TestBoard:async()=> 'Board online · test fixture',OpenPost:async id=>{localStorage.setItem('opened',id)}
  }}};
 },defaults);
 await page.goto('/');await expect(page.locator('#connection')).toContainText('ENGINE CONNECTED');
 await page.locator('[data-clock="fixed"]').click();await page.locator('#interval-dial').focus();await page.keyboard.press('ArrowUp');await expect(page.locator('#interval')).toHaveValue('301');
 const box=await page.locator('#interval-dial').boundingBox();await page.mouse.move(box!.x+40,box!.y+40);await page.mouse.down();await page.mouse.move(box!.x+40,box!.y+20);await page.mouse.up();await expect(page.locator('#interval')).not.toHaveValue('301');
 await page.locator('[data-route="agent"][data-choice="codex"]').click();await expect(page.locator('[data-route="agent"][data-choice="codex"]')).toHaveAttribute('aria-pressed','true');
 await page.locator('#save').click();const interval=await page.locator('#interval').inputValue();await page.reload();await expect(page.locator('#interval')).toHaveValue(interval);
 await page.locator('#token').fill('fixture-token');await page.locator('#show-token').click();await expect(page.locator('#token')).toHaveAttribute('type','text');await page.locator('#save').click();await expect(page.locator('#token-status')).toHaveText('SAVED LOCALLY');
 await page.locator('#clear-token').click();await page.locator('#save').click();await expect(page.locator('#token-status')).toHaveText('NOT SET');
 await page.locator('#add-entry').click();await page.locator('[name="name"]').fill('New persona');await page.locator('[name="prompt"]').fill('Ask good questions.');await page.locator('#entry-form [type="submit"]').click();await expect(page.locator('#library')).toContainText('New persona');
 await page.locator('#save').click();await page.locator('#test-board').click();await expect(page.locator('#board-result')).toContainText('Board online');
 await page.locator('#play').click();await expect(page.locator('#transport-status')).toContainText('SEQUENCING');await expect(page.locator('#prompt')).toBeDisabled();await page.locator('#stop').click();await expect(page.locator('#prompt')).toBeEnabled();
 await page.locator('#launch').click();await page.locator('[data-run="run"]').click();await expect(page.locator('#run-content')).toContainText('test post');await page.locator('#run-content summary').click();await expect(page.locator('#run-content pre')).toBeVisible();await page.locator('[data-open-post]').click();await expect.poll(()=>page.evaluate(()=>localStorage.getItem('opened'))).toBe('run');await page.locator('#close-run').click();
 await page.screenshot({path:'test-results/workstation.png',fullPage:true});expect(errors).toEqual([]);
});
