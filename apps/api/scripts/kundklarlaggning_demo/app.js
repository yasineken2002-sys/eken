'use strict';
let csrf = '';
const content = document.querySelector('#content');
const message = document.querySelector('#message');
const money = n => (n / 100).toLocaleString('sv-SE', {minimumFractionDigits: 2}) + ' kr';
function node(tag, text, parent) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (parent) parent.append(n); return n; }
function button(text, parent, action, secondary=false) { const b=node('button',text,parent); if(secondary)b.className='secondary'; b.onclick=async()=>{b.disabled=true;message.textContent='';try{await action();}catch(e){message.textContent=e.message;}finally{b.disabled=false;}};return b; }
async function api(path, data) { const response=await fetch(path,{method:data?'POST':'GET',headers:data?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{},body:data?JSON.stringify(data):undefined});const value=await response.json();if(!response.ok)throw Error(value.error);return value; }
function section(title) {const s=node('section',undefined,content);node('h2',title,s);return s;}
async function staff() {
 const data=await api('/api/staff');content.replaceChildren();const s=section('Personal · beslut och väntan');
 node('p','20 originalfall saknar säker mottagare. De får ingen kundlänk. B-fallen har separat tillagda syntetiska bevis.',s);
 const wrap=node('div',undefined,s);wrap.className='scroll';const table=node('table',undefined,wrap);const head=node('tr',undefined,table);['Betalning','Status','Lokal åtgärd'].forEach(t=>node('th',t,head));
 for(const c of data.cases){const row=node('tr',undefined,table);node('td',c.id,row);node('td',c.status,row);const actions=node('td',undefined,row);if(c.status==='DRAFT')button('Fånga förfrågan lokalt',actions,async()=>{await api('/api/capture',{case:c.id});await staff();});}
 const cr=section('Tillgodo kräver fortsatt hantering');
 node('p',data.credits.length?data.credits.map(c=>`${c.id}: ${money(c.remaining)} · ${c.lease}`).join('\n'):'Inga nya tillgodoposter i denna demokörning.',cr);
 node('p','Separat historik från #871, inte omräknad här: betalning-57-9 är fortfarande ett öppet ärende. 250 kr i ursprungsflöde A, 25 kr i alternativt flöde B.',cr);
 const audit=section('Spårbarhet · testunderlag');const details=node('details',undefined,audit);node('summary',`${data.audit.length} statusövergångar; visa aktör, källa och skäl`,details);node('pre',JSON.stringify(data.audit,null,2),details);
}
async function mailbox() { content.replaceChildren();const s=section('Kund · lokalt fångade frågor');const rows=await api('/api/mailbox');if(!rows.length)node('p','Du har inga tillgängliga betalningsfrågor.',s);for(const r of rows)button(r.payment,s,()=>customer(r.payment,r.token)); }
async function customer(id,token) {
 const data=await api('/api/customer?'+new URLSearchParams({case:id,token}));content.replaceChildren();const s=section('Vad avsåg din betalning?');
 node('p',money(data.amountOre),s).className='amount';node('p',data.date+' · '+data.payment,s);
 node('p','Den simulerade verifieraren har i detta exempel styrkt behörigheten för just betalningen. Ange uttryckliga belopp på egna avier. Olika avtal kvittas inte automatiskt.',s);
 const inputs={};for(const n of data.notices){const label=node('label',`${n.id} · avtal ${n.lease} · skuld ${money(n.debtOre)} `,s);const input=node('input',undefined,label);input.type='number';input.min='0';input.step='1';input.placeholder='Belopp i heltalsören';input.setAttribute('aria-label','Ören på '+n.id);inputs[n.id]=input;}
 const retainLabel=node('label',undefined,s);const retain=node('input',undefined,retainLabel);retain.type='checkbox';retainLabel.append(document.createTextNode(' Håll styrkt överskott separat som tillgodo. Fortsatt personalhantering krävs.'));
 const notes=node('label','Kommentar (aldrig verifierat bevis)',s);const note=node('textarea',undefined,notes);note.maxLength=400;
 node('p',data.credits.length?data.credits.map(c=>`${c.id}: ${money(c.remainingOre)} utestående`).join('\n'):'Tillgodo visas separat; inget flyttas automatiskt till annan avi.',s);
 let submission=null;
 async function respond(action){
   const allocations={};for(const [key,input] of Object.entries(inputs)){if(input.value&&Number(input.value)!==0){if(!/^[1-9][0-9]*$/.test(input.value))throw Error('Ange positiva heltalsören.');allocations[key]=Number(input.value);}}
   const response={payment:id,action,claim:action==='confirm'?'mine':'not-mine',allocations,retainCredit:retain.checked,note:note.value};
   if(!submission||JSON.stringify(submission.answer)!==JSON.stringify(response))submission={case:id,token,request:crypto.randomUUID(),answer:response};
   const result=await api('/api/reply',submission);content.replaceChildren();const done=section('Svar registrerat');
   node('p',result.status==='RESOLVED_CUSTOMER'?'Löst med kundens medverkan enligt testantagandena.':'Personal behöver fortsätta hanteringen. Ingen färdig hantering påstås.',done);
   node('p',result.status,done);button('Till mina frågor',done,mailbox);
 }
 button('Bekräfta fördelningen',s,()=>respond('confirm'));button('Betalningen är inte min',s,()=>respond('decline'),true);button('Tillbaka utan svar',s,mailbox,true);
}
async function load(){try{const me=await api('/api/me');csrf=me.csrf;document.querySelector('#identity').textContent=`Simulerad ${me.role}: ${me.person} · ${me.organization}`;await(me.role==='staff'?staff():mailbox());}catch(e){message.textContent='Använd demonstratörens privata startlänk för simulerad inloggning.';}}
const params=new URLSearchParams(location.search);if(location.pathname==='/demo'&&params.has('key')){const key=params.get('key');history.replaceState(null,'','/demo');document.querySelector('#launcher').hidden=false;for(const p of ['staff','alice','bob','other-org'])button(p,document.querySelector('#personas'),async()=>{await api('/api/demo-login',{key,persona:p});await load();});}
load();
