const $=id=>document.getElementById(id);
const CACHE_KEY='pipeline.snapshot.v1';
const LABELS={convert:'Converting',validate:'Validating',describe:'Describing',metadata:'Preparing metadata',ready:'Ready to upload',upload:'Uploading',verify:'Awaiting verification',verified:'Verified',shorts:'Waiting for matching clips',history:'Retained history',attention:'Needs attention'};
const SERVICE_NAMES={'video-downloader':'Recorder','video-server':'Library & finalization','video-auth':'Authentication','video-pipeline':'Conversion & uploads','video-xvfb':'Browser session','video-bunkr-downloads':'Bunkr downloads'};
let data=null, live=false, page='overview', filter='next', shown=40, timer=null, pending=null, generation=0;
let queueSignature=null,activitySignature=null;
const num=new Intl.NumberFormat('en');
export function bytes(n,precision=1){if(n===null||n===undefined||!Number.isFinite(Number(n)))return '—';if(n>=1e12)return `${(n/1e12).toFixed(precision)} TB`;if(n>=1e9)return `${(n/1e9).toFixed(precision)} GB`;if(n>=1e6)return `${(n/1e6).toFixed(precision)} MB`;return `${Math.round(n/1e3)} KB`;}
export function duration(n){if(n===null||n===undefined||!Number.isFinite(Number(n)))return '—';n=Math.max(0,Math.round(n));if(n>=3600)return `${Math.floor(n/3600)}h ${Math.floor(n%3600/60)}m`;if(n>=60)return `${Math.floor(n/60)}m ${n%60}s`;return `${n}s`;}
function time(value,withDate=false){const d=new Date(value);return Number.isNaN(d.valueOf())?'—':new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Tirane',...(withDate?{day:'numeric',month:'short'}:{}),hour:'2-digit',minute:'2-digit'}).format(d);}
function date(value){const d=new Date(String(value).slice(0,10)+'T12:00:00Z');return Number.isNaN(d.valueOf())?'—':new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'Europe/Tirane'}).format(d);}
function ago(value){const n=(Date.now()-new Date(value).valueOf())/1000;if(!Number.isFinite(n))return '—';return n<10?'just now':n<60?`${Math.floor(n)}s ago`:n<3600?`${Math.floor(n/60)}m ago`:n<86400?`${Math.floor(n/3600)}h ago`:`${Math.floor(n/86400)}d ago`;}
function el(tag,className,text){const n=document.createElement(tag);if(className)n.className=className;if(text!==undefined)n.textContent=String(text);return n;}
function text(id,value){$(id).textContent=value;}
function provider(name){return el('span','provider '+(name||''),name==='tango'?'TANGO':name==='sc'?'SC':name==='fc2'?'FC2':name||'LOCAL');}
function empty(message){return el('p','empty-inline',message);}
function formatCount(n){return n===null||n===undefined?'—':num.format(n);}
function working(){return data?.services['video-pipeline']?.state==='active'&&!['user_paused','paused','worker_stopped','worker_unresponsive','status_unavailable','cooldown'].includes(data.campaign.state);}
function setConnection(ok,message){live=ok;document.body.classList.toggle('saved-data',!ok);$('refresh').classList.toggle('offline',!ok);text('connection-label',ok?'Live':data?'Saved':'Offline');$('connection-banner').hidden=ok;if(!ok)text('connection-banner',message||`Connection interrupted. Showing the last snapshot from ${data?time(data.generated_at,true):'this phone'}.`);}

function renderHero(){
 const a=data.active,c=data.campaign,state=c.state;
 const paused=['user_paused','paused','worker_stopped','worker_unresponsive'].includes(state);
 $('now-card').classList.toggle('paused',paused);
 let title=a?`${LABELS[a.stage]||'Working'}.`:'Ready for what’s next.';
 let tag=a?LABELS[a.stage]:'PIPELINE RUNNING',detail=a?`${(a.provider||'local').toUpperCase()} · ${date(a.captured_at)} · ${duration(a.seconds)}`:`${data.counts.capturing} recording${data.counts.capturing===1?'':'s'} live · ${formatCount(data.counts.verified)} verified`;
 if(a?.stage==='upload'&&a.progress?.percent>=100){title=a.phase==='metadata_submitting'?'Publishing the upload.':'Finishing the upload.';tag=a.phase==='metadata_submitting'?'SUBMITTING DETAILS':'PROVIDER ASSEMBLY';}
 if(state==='user_paused'||state==='paused'){title='Taking a breather.';tag='UPLOAD WORKER PAUSED';detail=`${data.counts.capturing} live recording${data.counts.capturing===1?'':'s'} · capture stays independent`;}
 if(state==='worker_stopped'){title='Worker is stopped.';tag='UPLOAD WORKER OFFLINE';detail='Your queue and completed work are preserved.';}
 if(state==='worker_unresponsive'){title='Checking on the worker.';tag='HEARTBEAT LATE';detail=`Last signal ${ago(c.worker_heartbeat)}. The queue snapshot is preserved.`;}
 if(state==='cooldown'){title='A moment to retry.';tag='AUTOMATIC RETRY';detail=`Retry ${time(c.resume_at,true)} · the queue keeps its place`;}
 if(state==='monthly_quota_wait'){title='Waiting for allowance.';tag='AUTOMATIC BUDGET WAIT';detail=`More allowance on ${date(data.budget.next_release)}. No manual resume needed.`;}
 if(state==='resource_wait'){title='Waiting for room.';tag='RESOURCE WAIT';detail=c.step?.reason||'The next stage will start when resources are available.';}
 if(state==='status_unavailable'){title='Checking worker status.';tag='SERVICE STATUS UNAVAILABLE';detail='The queue snapshot is available; service status is temporarily unavailable.';}
 if(state==='finishing'){tag='FINISHING ACTIVE WORK';}
 text('now-state',live?tag.toUpperCase():`LAST SEEN · ${tag.toUpperCase()}`);text('now-title',title);
 text('now-alias',a?a.alias:'');text('now-detail',detail);
 const elapsed=a?.started_at?(Date.now()-new Date(a.started_at).valueOf())/1000:null;
 text('job-elapsed',a&&!paused?`${duration(elapsed)} elapsed`:'');
 const p=a?.progress;
 $('job-progress').classList.toggle('indeterminate',Boolean(a&&!p&&!paused));
 $('job-fill').style.width=p?`${Math.min(100,Math.max(0,p.percent))}%`:paused?'0%':'';
 text('progress-number',p?`${p.percent.toFixed(1)}%`:a&&!paused?'In progress':'');
 text('progress-detail',p?`${bytes(p.acknowledged_bytes)} of ${bytes(p.total_bytes)} acknowledged`:a?.stage==='convert'&&a.output_bytes?`${bytes(a.output_bytes)} written so far`:a&&!paused?`Processing ${a.size_bytes?bytes(a.size_bytes)+' · ':''}${duration(a.seconds)} of footage`:paused?'Work resumes when the upload worker is enabled.':'Watching for the next finalized recording.');
 const extras=[];
 if(p){if(!p.fresh)extras.push(`Progress last reported ${ago(p.updated_at)}`);else if(p.percent>=100)extras.push('File transfer complete; provider processing and verification follow.');else if(p.bytes_per_second)extras.push(`${(p.bytes_per_second*8/1e6).toFixed(1)} Mbps · roughly ${duration(p.eta_seconds)} remaining`);if(p.percent<100)extras.push('Transfer progress; online verification follows.');}
 else if(a?.stage==='upload')extras.push('Transfer in progress. Online verification follows.');
 if(a?.reservation_month&&a.reservation_month!==data.budget.month)extras.push(`Budgeted in ${new Intl.DateTimeFormat('en',{month:'long',year:'numeric'}).format(new Date(a.reservation_month+'-15T12:00:00Z'))}.`);
 text('job-extra',extras.join(' '));
}

function renderStages(){
 const c=data.counts,a=working()?data.active:null;
 const specs=[['capture','◉','Record',c.capturing,c.capturing>0,false],['finalize','◇','Finalize',data.finalization.processing,data.finalization.processing>0,false],
 ['convert','◫','Convert',a&&['convert','validate'].includes(a.stage)?1:0,a&&['convert','validate'].includes(a.stage),false],
 ['describe','✧','Describe',a&&['describe','metadata'].includes(a.stage)?1:0,a&&['describe','metadata'].includes(a.stage),false],
 ['upload','↑','Upload',a?.stage==='upload'?1:0,a?.stage==='upload',false],['verify','✓','Verify',c.confirming,false,c.confirming>0]];
 const map=$('pipeline-map');map.replaceChildren();
 for(const [key,icon,label,count,active,waiting] of specs){const n=el('button','pipe-node'+(active?' active':'')+(waiting?' waiting':''));n.setAttribute('aria-label',`${label}: ${formatCount(count)}${active?' active':''}`);const top=el('div','node-top');top.append(el('span','node-icon',icon),el('span','node-light'));n.append(top,el('strong','',formatCount(count)),el('span','node-label',label));n.addEventListener('click',()=>{if(key==='capture'||key==='finalize')$('capture-strip').scrollIntoView({behavior:'smooth',block:'center'});else openQueue(key==='verify'?'verify':key);});map.append(n);}
 const list=$('capture-strip');list.replaceChildren();
 if(!data.captures.length)list.append(empty('No streams are recording right now. The recorder keeps watching.'));
 for(const capture of data.captures.slice(0,6)){const row=el('div','capture-line');row.append(provider(capture.provider),el('span','alias',capture.alias),el('span','capture-time',capture.active?`${duration(capture.seconds)} · ${formatCount(capture.segments)} segments`:'Waiting for stream'));list.append(row);}
 if(data.captures.length>6)list.append(empty(`+ ${data.captures.length-6} more live recordings`));
}

function renderBudget(){
 const b=data.budget;const month=new Date(b.month+'-15T12:00:00Z');text('budget-month',new Intl.DateTimeFormat('en-GB',{month:'long',year:'numeric',timeZone:'Europe/Tirane'}).format(month).toUpperCase()+' · UPLOAD ALLOWANCE');
 text('budget-remaining',bytes(b.remaining,0));
 $('released-ring').setAttribute('stroke-dasharray',`${Math.min(100,b.released/b.monthly_limit*100)} 100`);
 $('used-ring').setAttribute('stroke-dasharray',`${Math.min(100,(b.spent+b.reserved)/b.released*100)} 100`);
 $('used-ring').style.opacity=b.spent+b.reserved>0?'1':'0';
 const numbers=$('budget-numbers');numbers.replaceChildren();for(const [value,label] of [[bytes(b.released,0),'Released this month'],[b.spent?bytes(b.spent):'0 GB','Spent · retries included'],[b.reserved?bytes(b.reserved):'0 GB','Committed to transfers']]){const n=el('div','budget-value');n.append(el('strong','',value),el('span','',label));numbers.append(n);}
 const schedule=$('release-schedule');schedule.replaceChildren();for(const [i,r] of b.releases.entries()){const active=i===(b.day<=10?0:b.day<=20?1:2);const n=el('div','release-step'+(active?' current':''));n.append(el('span','',i===0?'DAYS 1–10':i===1?'DAYS 11–20':'DAY 21+'),el('strong','',bytes(Math.min(b.monthly_limit,r.bytes),0)));schedule.append(n);}
 text('budget-note',`${bytes(b.next_amount,0)} total allowance from ${date(b.next_release)}. Unused allowance carries within the month.`);
}

function svgNode(name,attributes){const n=document.createElementNS('http://www.w3.org/2000/svg',name);for(const [key,value] of Object.entries(attributes||{}))n.setAttribute(key,String(value));return n;}
function renderHistory(){
 const days=data.history,max=Math.max(1,...days.flatMap(d=>[d.submitted,d.verified]));const totals={submitted:days.reduce((s,d)=>s+d.submitted,0),verified:days.reduce((s,d)=>s+d.verified,0)};
 const top=$('history-totals');top.replaceChildren();for(const [key,label] of [['submitted','Submitted'],['verified','Verified']]){const n=el('div','history-total');n.append(el('strong','',formatCount(totals[key])),el('span','',label));top.append(n);}
 const svg=svgNode('svg',{viewBox:'0 0 320 128','aria-hidden':'true'});for(const y of [10,50,90])svg.append(svgNode('line',{x1:0,y1:y,x2:320,y2:y,stroke:'#263744','stroke-dasharray':'2 5'}));
 for(const [i,day] of days.entries()){const x=i*23;for(const [j,key,color] of [[0,'submitted','#b9a3ff'],[1,'verified','#79e7c4']]){const h=day[key]/max*78;const rect=svgNode('rect',{x:x+j*8+2,y:90-Math.max(2,h),width:6,height:Math.max(2,h),rx:2,fill:color,opacity:day[key]?1:.2});const title=svgNode('title');title.textContent=`${day.date}: ${day[key]} ${key}`;rect.append(title);svg.append(rect);}if(i===0||i===6||i===13){const t=svgNode('text',{x:x+7,y:116,fill:'#8098aa','font-size':8,'text-anchor':i===0?'start':i===13?'end':'middle'});t.textContent=day.date.slice(8)+' '+new Intl.DateTimeFormat('en',{month:'short'}).format(new Date(day.date+'T12:00:00Z'));svg.append(t);}}
 $('history-chart').replaceChildren(svg);$('history-chart').setAttribute('aria-label',`Last fourteen days: ${totals.submitted} submissions and ${totals.verified} verified copies. ${days.map(d=>`${d.date}: ${d.submitted} submitted, ${d.verified} verified`).join('. ')}`);
}

function renderShorts(){
 const summary=$('shorts-summary');summary.replaceChildren();for(const [count,label] of [[data.counts.short_waiting,'clips waiting normally'],[data.counts.prepared_batches,'batches ready to process']]){const n=el('div','short-tile');n.append(el('strong','',formatCount(count)),el('span','',label));summary.append(n);}
 const batches=$('short-batches');batches.replaceChildren();for(const b of data.shorts.batches.slice(0,4)){const n=el('div','batch-row');const left=el('div');left.append(el('strong','',b.alias),el('small','',`${b.clips} compatible clips · ${b.orientation}`));const parts=el('div','batch-parts');for(let i=0;i<Math.min(12,b.clips);i++)parts.append(el('span','batch-part'));left.append(parts);n.append(left,el('span','batch-meta',duration(b.seconds)));batches.append(n);}
 if(!data.shorts.batches.length)batches.append(empty('Matching footage will form batches automatically.'));
}

function renderStorage(){
 const s=data.storage,inv=s.inventory||{},used=s.total-s.free;text('disk-free',`${bytes(s.free,0)} free`);
 const rail=$('storage-rail'),legend=$('storage-legend');rail.replaceChildren();legend.replaceChildren();
 for(const [value,color] of [[used,'#7db7ff'],[s.free,'#79e7c4']]){const segment=el('span','storage-segment');segment.style.width=`${Math.max(0,value/s.total*100)}%`;segment.style.background=color;rail.append(segment);}
 const rows=[['Disk used',used,'#7db7ff'],['Available',s.free,'#79e7c4'],['Recordings',inv.downloads,'#7db7ff'],['Conversions',inv.artifacts,'#b9a3ff'],['Review & Trash',inv.retained_trash===undefined?undefined:(inv.retained_trash+(inv.desktop_staging||0)),'#e5bd7d']];
 for(const [label,value,color] of rows){if(value===null||value===undefined)continue;const n=el('div','storage-key'),key=el('span'),dot=el('i');dot.style.background=color;key.append(dot,document.createTextNode(label));n.append(key,el('strong','',bytes(value)));legend.append(n);}
 text('storage-note',`The bar and disk totals are live. Folder sizes ${s.inventory_at?'last measured '+time(s.inventory_at,true):'are unavailable'}. Files in Trash still use space.`);
}

function renderServices(){
 const list=$('services');list.replaceChildren();for(const [id,label] of Object.entries(SERVICE_NAMES)){const s=data.services[id]||{state:'unknown'};const row=el('div','service-row');const dot=el('span','service-light'+(s.state==='active'?'':s.state==='unknown'?' unknown':' stopped'));const name=el('div','',label);name.append(el('small','',s.state==='active'?`Running ${duration(s.uptime_seconds)}`:s.state==='inactive'&&id==='video-pipeline'?'Stopped · manual control':s.state));const values=el('div','service-values',s.cpu_percent===null||s.cpu_percent===undefined?'CPU —':`${s.cpu_percent.toFixed(1)}% CPU`);values.append(el('small','',bytes(s.anonymous_bytes)));row.append(dot,name,values);list.append(row);}
 text('retained-summary',`${formatCount(data.health.historical_removals)} historical provider removals · acknowledged`);
 text('monitoring-note',`Babysitting: ${data.monitoring.cadence||'scheduled'}. Last completed check ${data.monitoring.last_check?time(data.monitoring.last_check,true):'not yet recorded'}. Service RAM excludes file cache.`);
}

function renderQueue(){
 if(!data)return;
 const signature=JSON.stringify([filter,shown,$('queue-search').value,working(),data.active?.id,data.active?.stage,data.queue,data.confirmations,data.shorts]);
 if(signature===queueSignature)return;queueSignature=signature;
 const anchor=page==='queue'?[...document.querySelectorAll('.queue-row')].find(n=>n.getBoundingClientRect().bottom>20):null;
 const anchorId=anchor?.dataset.id,anchorTop=anchor?.getBoundingClientRect().top;
 const filters=[['next','Next up'],['shorts','Shorts'],['verify','Verifying']];if(!filters.some(([key])=>key===filter))filters.push([filter,filter==='convert'?'Convert':filter==='describe'?'Describe':'Upload']);
 const controls=$('queue-filters');controls.replaceChildren();for(const [key,label] of filters){const b=el('button',key===filter?'selected':'',label);b.setAttribute('aria-pressed',String(key===filter));b.addEventListener('click',()=>{filter=key;shown=40;renderQueue();});controls.append(b);}
 let rows=[];if(filter==='shorts')rows=[...data.shorts.waiting,...data.shorts.batches];else if(filter==='verify')rows=data.confirmations.map(r=>({id:r.recording_id,alias:r.alias,stage:'verify',confirm_after:r.confirm_after,remote_id:r.remote_id}));else{rows=[...(data.active?[data.active]:[]),...data.queue];if(filter==='convert')rows=rows.filter(r=>['convert','validate'].includes(r.stage));else if(filter==='describe')rows=rows.filter(r=>['describe','metadata'].includes(r.stage));else if(filter==='upload')rows=rows.filter(r=>['upload','ready'].includes(r.stage));}
 const query=$('queue-search').value.trim().toLocaleLowerCase();rows=rows.filter(r=>(r.alias+' '+r.id).toLocaleLowerCase().includes(query));
 text('queue-count',`${num.format(rows.length)} ${filter==='shorts'?'clips and prepared batches':filter==='verify'?'copies awaiting checks':'jobs'}${query?' matching your search':''}`);
 const list=$('queue-list');list.replaceChildren();for(const [i,r] of rows.slice(0,shown).entries()){const n=el('article','queue-row');n.dataset.id=r.id;const current=data.active?.id===r.id,active=current&&working();const main=el('div','queue-main');main.append(el('strong','',r.alias));const details=el('div','row-details');if(r.provider)details.append(provider(r.provider));details.append(document.createTextNode(r.confirm_after?`Check ${time(r.confirm_after,true)}`:date(r.captured_at||r.id)));main.append(details);const meta=el('div','queue-meta');meta.append(el('strong','',r.seconds?duration(r.seconds):r.remote_id?`#${r.remote_id}`:'—'),el('span','',active?'Working now':current?'Last active job':r.clips?`${r.clips} clips joined`:LABELS[r.stage]||r.stage));n.append(el('span','queue-position',active?'•':String(i+1).padStart(2,'0')),main,meta);list.append(n);}
 if(!rows.length)list.append(empty(query?'No recordings match that search.':'Nothing waiting here right now.'));
 $('show-more').hidden=rows.length<=shown;
 if(anchorId){const restored=[...list.children].find(n=>n.dataset.id===anchorId);if(restored)window.scrollBy(0,restored.getBoundingClientRect().top-anchorTop);}
}

function renderActivity(){
 const signature=JSON.stringify([data.activity,data.counts.converted,data.counts.submitted,data.counts.receipts_verified]);if(signature===activitySignature)return;activitySignature=signature;
 const stats=$('activity-stats');stats.replaceChildren();for(const [count,label] of [[data.counts.converted,'Converted · 24h'],[data.counts.submitted,'Submitted · 24h'],[data.counts.receipts_verified,'Verified · 24h']]){const n=el('div','activity-stat');n.append(el('strong','',formatCount(count)),el('span','',label));stats.append(n);}
 const list=$('activity-list');list.replaceChildren();for(const r of data.activity){const n=el('article','activity-row'+(r.stage==='verified'?' verified':''));n.append(el('strong','',r.alias),el('span','event-label',LABELS[r.stage]||r.stage));const t=el('time','',time(r.at,true));t.dateTime=r.at;n.append(t);list.append(n);}if(!data.activity.length)list.append(empty('No recent transitions. The next stage will appear here.'));
}

function render(snapshot,isLive){
 data=snapshot;live=isLive;$('loading').hidden=true;$('dashboard').hidden=false;document.body.classList.toggle('saved-data',!isLive);
 text('overview-date',new Intl.DateTimeFormat('en-GB',{weekday:'long',day:'numeric',month:'long',timeZone:'Europe/Tirane'}).format(new Date(snapshot.generated_at)).toUpperCase());
 const healthyLabels={user_paused:'Paused by you',paused:'Upload worker paused',cooldown:'Retry scheduled',monthly_quota_wait:'Waiting for allowance',resource_wait:'Waiting for resources',status_unavailable:'Service status unavailable'};
 text('health-label',!isLive?'Last known status':snapshot.health.attention?`${snapshot.health.attention} need attention`:healthyLabels[snapshot.campaign.state]||'All moving as expected');$('health-label').classList.toggle('attention',snapshot.health.attention>0||snapshot.campaign.state==='status_unavailable');
 const stats=$('summary-stats');stats.replaceChildren();for(const [value,label] of [[snapshot.counts.verified,'Verified recordings'],[snapshot.counts.ready,'Jobs waiting'],[snapshot.counts.short_waiting,'Shorts waiting'],[snapshot.counts.submitted,'Submitted · 24h']]){const n=el('div','stat');n.append(el('strong','',formatCount(value)),el('span','',label));stats.append(n);}
 const attention=$('attention');attention.hidden=!snapshot.health.attention;attention.replaceChildren();if(snapshot.health.attention){attention.append(el('strong','',`${snapshot.health.attention} things need attention`));for(const alert of snapshot.health.alerts.slice(0,3))attention.append(el('p','',alert.message));}
 renderHero();renderStages();renderBudget();renderHistory();renderShorts();renderStorage();renderServices();renderQueue();renderActivity();text('snapshot-time',`${isLive?'Updated':'Saved snapshot'} ${time(snapshot.generated_at,true)} · Tirana time`);
}

function navigate(name){if(!['overview','queue','activity'].includes(name))return;page=name;for(const node of document.querySelectorAll('.page'))node.hidden=node.id!==page;for(const b of document.querySelectorAll('[data-page]')){b.classList.toggle('selected',b.dataset.page===page);if(b.dataset.page===page)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');}window.scrollTo({top:0,behavior:'instant'});history.replaceState(null,'','#'+page);}
function openQueue(key){filter=key;shown=40;$('queue-search').value='';renderQueue();navigate('queue');}
function usable(value){return value&&value.counts&&value.campaign&&value.budget&&value.health&&Array.isArray(value.health.alerts)&&value.services&&value.storage&&value.finalization&&value.monitoring&&value.shorts&&Array.isArray(value.shorts.waiting)&&Array.isArray(value.shorts.batches)&&Array.isArray(value.queue)&&Array.isArray(value.history)&&Array.isArray(value.activity)&&Array.isArray(value.captures)&&Array.isArray(value.confirmations)&&Array.isArray(value.budget.releases);}
async function refresh(force=false){
 if(document.hidden)return;if(pending&&!force)return;if(pending)pending.abort();clearTimeout(timer);const mine=++generation,controller=new AbortController();pending=controller;const deadline=setTimeout(()=>controller.abort(),5500);
 try{const response=await fetch('/api/dashboard',{cache:'no-store',signal:controller.signal});const body=await response.json();if(mine!==generation||document.hidden)return;if(!response.ok||!body.ok){if(usable(body.snapshot))render(body.snapshot,false);throw Error('unavailable');}if(!usable(body.snapshot))throw Error('invalid');render(body.snapshot,true);setConnection(true);try{localStorage.setItem(CACHE_KEY,JSON.stringify(body.snapshot));}catch{}}
 catch{if(mine!==generation||document.hidden)return;setConnection(false);if(data)render(data,false);else{$('loading').querySelector('p').textContent='Your PC is unreachable right now. This page will reconnect automatically.';$('loading').querySelector('.loading-rail').hidden=true;}}
 finally{clearTimeout(deadline);if(mine===generation){pending=null;if(!document.hidden)timer=setTimeout(()=>refresh(),live?5000:15000);}}
}

for(const button of document.querySelectorAll('[data-page]'))button.addEventListener('click',()=>navigate(button.dataset.page));
document.querySelector('.brand').addEventListener('click',event=>{event.preventDefault();navigate('overview');});
$('refresh').addEventListener('click',()=>refresh(true));$('show-shorts').addEventListener('click',()=>openQueue('shorts'));$('show-more').addEventListener('click',()=>{shown+=40;renderQueue();});$('queue-search').addEventListener('input',()=>{shown=40;renderQueue();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(timer);generation++;pending?.abort();pending=null;}else refresh(true);});
for(const name of ['online','pageshow','focus'])window.addEventListener(name,()=>{if(!document.hidden)refresh(true);});
window.addEventListener('offline',()=>setConnection(false));
try{const saved=JSON.parse(localStorage.getItem(CACHE_KEY)||'null');if(usable(saved)){render(saved,false);setConnection(false,`Saved snapshot from ${time(saved.generated_at,true)}. Connecting to your PC…`);}}catch{}
navigate(location.hash.slice(1)||'overview');refresh();
if('serviceWorker'in navigator&&window.isSecureContext)navigator.serviceWorker.register('/sw.js').catch(()=>{});
