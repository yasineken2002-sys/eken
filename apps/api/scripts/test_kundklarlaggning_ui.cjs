// Small actual app.js interaction control with a fake DOM, NOT a browser test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tag) { this.tag=tag; this.children=[]; this.value=''; this.checked=false; this.textContent=''; }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children=children; }
  setAttribute() {}
}
const elements = Object.fromEntries(['#content','#message','#identity','#launcher','#personas'].map(k=>[k,new Element('div')]));
const calls=[];
const context=vm.createContext({URLSearchParams, console,
  document:{querySelector:k=>elements[k],createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text})},
  location:{search:'',pathname:'/'},history:{replaceState(){}},crypto:{randomUUID:()=> 'ui-control-request'},
  fetch:async (url,options)=>{
    const data=options.body?JSON.parse(options.body):undefined;calls.push({url,data});
    let value=[];
    if(url==='/api/me')value={person:'alice',organization:'syntetisk',role:'customer',csrf:'SIMULATED'};
    if(url.startsWith('/api/customer?'))value={payment:'B-full',amountOre:10000,date:'2026-09-09',
      notices:[{id:'B-full-avi-1',lease:'B-full-home',debtOre:10000}],credits:[]};
    if(url==='/api/reply')value={status:'STAFF_DECLINED'};
    return {ok:true,json:async()=>value};
  }
});
function descendants(n) {return [n,...n.children.flatMap(c=>c.children?descendants(c):[c])];}
(async()=>{
  const source=fs.readFileSync(path.join(__dirname,'kundklarlaggning_demo/app.js'),'utf8');
  vm.runInContext(source,context);
  await new Promise(resolve=>setImmediate(resolve));
  await vm.runInContext("customer('B-full','SYNTHETIC_LINK')",context);
  let nodes=descendants(elements['#content']);
  nodes.find(n=>n.tag==='input'&&n.type==='number').value='1.5';
  const decline=nodes.find(n=>n.tag==='button'&&n.textContent==='Betalningen är inte min');
  await decline.onclick();
  const response=calls.find(c=>c.url==='/api/reply').data;
  assert.equal(response.answer.action,'decline');assert.deepEqual(response.answer.allocations,{});
  assert.equal(response.answer.claim,'not-mine');
  assert.ok(calls.some(c=>c.url==='/api/credits'));
  console.log('PASS: actual app.js decline ignores abandoned fractional amount and refreshes own credit (fake DOM, no browser rendering).');
})().catch(error=>{console.error(error);process.exitCode=1;});
