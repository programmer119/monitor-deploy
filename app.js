const API_BASE = 'https://api-monitor.suaveforge.com';
const TOKEN_KEY = 'suaveforge-monitor-admin-token';
let adminToken = localStorage.getItem(TOKEN_KEY) || '';
const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
let snapshot = {projects:[], history:[], recommendations:[], discovery:{}, hubs:[], updated:null};
let serverSnapshot = {summary:{},cpu:{},memory:{},filesystems:[],postgresql:{},docker_runtime:{},kernel:{},logs:[],root_top:[],services:[]};
let actionsSnapshot = {org:'suaveforge',target_runner_name:'123-suaveforge-org-01',summary:{},repositories:[],queue:[],recent_failures:[],state:'checking'};
let actionsLastFetched = 0;
let actionsStateReady = false;
let actionsPrevious = null;
let monitorMode = 'operations';
const ACTIONS_POLL_MS = 45000;
let serverLastFetched = 0;
let serverAbnormalOnly = false;
const serverMetricHistory={cpu:[],ram:[],root:[],home:[]};
let filter = 'all';
let expanded = new Set();
let lastFetched = 0;

const statusText = {normal:'정상', slow:'지연', suspect:'재확인', down:'장애', unknown:'미확인', degraded:'주의', planned:'예정', disabled:'미사용', sync_error:'동기화 오류'};

function esc(v=''){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function targetProjectStatus(p){
  const ts=(p.targets||[]).filter(t=>t.enabled && t.endpoint);
  if(!p.enabled || ts.length===0) return 'unknown';
  if(ts.some(t=>t.critical && t.status==='down')) return 'down';
  if(ts.some(t=>['down','suspect','slow'].includes(t.status))) return 'degraded';
  if(ts.every(t=>t.status==='normal')) return 'normal';
  return 'unknown';
}
function projectRuntimeInfo(p){
  const items=(serverSnapshot.services||[]).filter(v=>v.project_id===p.id);
  if(!items.length)return null;
  const running=items.filter(v=>v.status==='running').length;
  const down=items.filter(v=>v.status==='down').length;
  const degraded=items.filter(v=>v.status==='degraded').length;
  const review=items.filter(v=>['unknown','review'].includes(v.status)).length;
  const dockerItems=items.filter(v=>v.manager==='docker');
  const docker=serverSnapshot.docker_runtime||{};
  const parentDockerDown=!!(dockerItems.length&&docker.installed&&!docker.running);
  let state='normal';
  if(parentDockerDown||down)state='down';
  else if(degraded)state='degraded';
  else if(review)state='unknown';
  return {state,items,total:items.length,running,down,degraded,review,dockerCount:dockerItems.length,parentDockerDown};
}
function projectStatusInfo(p){
  const target=targetProjectStatus(p),runtime=projectRuntimeInfo(p);
  if(!runtime)return {state:target,target,runtime:null,label:statusText[target]||target};
  const rank={normal:0,unknown:1,degraded:2,down:3};
  const state=(rank[runtime.state]||0)>(rank[target]||0)?runtime.state:target;
  let label=statusText[state]||state;
  if(runtime.state==='down'&&target!=='down')label='서버 장애';
  else if(runtime.state==='degraded'&&target==='normal')label='서버 주의';
  else if(runtime.state==='unknown'&&target==='normal')label='서버 확인';
  return {state,target,runtime,label};
}
function projectStatus(p){return projectStatusInfo(p).state;}
function dateValue(v){const d=new Date(v);return Number.isNaN(+d)?null:d;}
function since(v){const d=dateValue(v);if(!d)return '-';let s=Math.max(0,Math.floor((Date.now()-d)/1000));if(s<60)return `${s}초 전`;if(s<3600)return `${Math.floor(s/60)}분 전`;if(s<86400)return `${Math.floor(s/3600)}시간 전`;return `${Math.floor(s/86400)}일 전`;}
function countdown(v){const d=dateValue(v);if(!d)return '-';let s=Math.max(0,Math.ceil((d-Date.now())/1000));if(s<60)return `${s}초`;if(s<3600)return `${Math.floor(s/60)}분 ${s%60}초`;return `${Math.floor(s/3600)}시간 ${Math.floor((s%3600)/60)}분`;}
function statusClass(s){return ['normal','slow','suspect','down'].includes(s)?s:'unknown';}
function targetKind(k){return ({http:'HTTP',https:'HTTPS',tcp:'TCP',redis:'Redis',memcache:'Memcache',memcached:'Memcache',postgres:'PostgreSQL',mysql:'MySQL',mariadb:'MariaDB',dns:'DNS',tls:'TLS',ssl:'SSL'})[k]||k.toUpperCase();}
function infraItems(p){const x=p.infrastructure||{};return [['FRONT',x.frontend,'Frontend'],['WEB',x.proxy_web,'Proxy / Web'],['APP',x.app_server,'Backend / App'],['DB',x.database,'Database'],['TLS',x.tls,'TLS / Certificate'],['EDGE',x.edge,'Edge / Hosting']].filter(([,v])=>String(v||'').trim());}
function stackParts(...values){const out=[];for(const raw of values){for(const part of String(raw||'').split('·')){const v=part.trim();if(v&&!out.some(x=>x.toLowerCase()===v.toLowerCase()))out.push(v)}}return out;}
function infraGroup(p,key){const x=p.infrastructure||{};if(key==='front')return stackParts(x.frontend).join(' · ');if(key==='proxy')return stackParts(x.proxy_web).join(' · ');if(key==='app')return stackParts(x.app_server).join(' · ');if(key==='database')return stackParts(x.database).join(' · ');if(key==='tls')return stackParts(x.tls).join(' · ');if(key==='edge')return stackParts(x.edge).join(' · ');return '';}
function infraState(p,key){const x=p.infrastructure_state||{};const map={front:'frontend',proxy:'proxy_web',app:'app_server',database:'database',tls:'tls',edge:'edge'};return x[map[key]]||{state:'unknown',message:'아직 확인되지 않음'};}
function infraCell(value,fieldState={}){if(value)return `<div class="stack-cell" title="${esc(fieldState.message||value)}">${esc(value)}</div>`;const st=fieldState.state||'unknown',msg=fieldState.message||(st==='absent'?'해당 구성 없음':st==='error'?'검출 오류':'확인 불가');if(st==='absent')return `<div class="stack-cell empty-stack infra-empty infra-absent" title="${esc(msg)}" aria-label="해당 구성 없음">—</div>`;if(st==='error')return `<div class="stack-cell empty-stack infra-empty infra-error" title="${esc(msg)}"><span class="infra-state-icon infra-error-icon" aria-label="검출 오류">⚠</span></div>`;return `<div class="stack-cell empty-stack infra-empty infra-unknown" title="${esc(msg)}"><span class="infra-state-icon infra-unknown-icon" aria-label="확인 불가">?</span></div>`;}
function hubDef(id){return (snapshot.hubs||[]).find(h=>h.id===id)||null;}
function hubConnMap(p){const m={};for(const c of (p.hubs||[]))m[c.hub_id]=c;return m;}
function hubCell(p){
  const defs={auth:'AUTH',pay:'PAY',localize:'LOC'}, conns=hubConnMap(p);
  const items=Object.entries(defs).filter(([id])=>conns[id]?.enabled).map(([id,label])=>{const c=conns[id],h=hubDef(id),st=c.status||h?.status||'unknown';return `<span class="hub-mini ${esc(st)}" title="${esc(h?.name||id)} · ${esc(c.message||h?.message||statusText[st]||'미확인')}">${label}</span>`});
  return items.length?`<div class="hub-cell">${items.join('')}</div>`:`<div class="hub-cell empty-stack"></div>`;
}
function renderHubOverview(){
  const el=$('#hubCards');if(!el)return;
  el.innerHTML=(snapshot.hubs||[]).map(h=>{const st=h.mode==='planned'?'planned':(h.status||'unknown');const health=h.mode==='planned'?'추가 예정':(h.last_check_at?`${h.response_ms||'-'} ms · ${since(h.last_check_at)}`:'확인 대기');const sync=h.mode==='planned'?'DB 연동 예정':(h.sync_status==='normal'?'Hub DB 동기화 정상':(h.sync_message||'Hub DB 동기화 대기'));const detail=`${health} · ${sync}`;return `<article class="hub-card"><div class="hub-card-title"><span class="dot ${statusClass(st)}"></span><strong>${esc(h.name)}</strong><span class="hub-mode ${esc(st)}">${esc(statusText[st]||st)}</span></div><div class="hub-url">${h.public_url?`<a href="${esc(h.public_url)}" target="_blank" rel="noreferrer">${esc(h.public_url)}</a>`:'URL 미등록'}</div><small>${esc(detail)}</small></article>`}).join('');
}
function renderRecommendations(){
  const list=$('#recommendationList'), meta=$('#discoveryMeta');if(!list||!meta)return;
  const d=snapshot.discovery||{}, recs=snapshot.recommendations||[];
  meta.textContent=d.last_error?`마지막 탐지 실패 · ${d.last_error}`:d.last_check_at?`6시간 주기 자동 탐지 · 마지막 ${since(d.last_check_at)} · 후보 ${recs.length}`:'6시간 주기 자동 탐지 · 첫 확인 대기';
  const urlLabels={verified:'URL 확인됨',protected:'접근제한 확인',suspect:'URL 확인 필요',missing:'URL 미확인'};
  list.innerHTML=recs.length?recs.map(r=>{const us=r.url_status||'missing',ul=urlLabels[us]||'URL 미확인';return `<article class="recommendation-item"><div><strong>${esc(r.name)}</strong><span>${esc(r.repository)}</span><div class="recommendation-url-line"><small title="${esc(r.public_url||'')}">${r.public_url?esc(r.public_url):'운영 URL을 찾지 못했습니다.'}</small><em class="url-check ${esc(us)}">${esc(ul)}</em></div>${r.url_message?`<p class="recommendation-url-message">${esc(r.url_message)}</p>`:''}</div><button class="button primary small register-recommendation" data-recommendation="${esc(r.id)}">${us==='verified'||us==='protected'?'등록':'URL 확인 후 등록'}</button></article>`}).join(''):`<div class="recommendation-empty">현재 새로 추천할 프로젝트가 없습니다.</div>`;
}
let toastTimer=0;
function toast(msg,type='default',duration=2200){const el=$('#toast');if(!el)return;clearTimeout(toastTimer);el.textContent=msg;el.classList.remove('queued','success','failure');if(type!=='default')el.classList.add(type);el.classList.add('show');toastTimer=setTimeout(()=>{el.classList.remove('show','queued','success','failure')},duration);}

function showLogin(message=''){
  const dlg=$('#loginDialog');
  $('#loginError').textContent=message;
  $('#adminTokenInput').value='';
  if(!dlg.open) dlg.showModal();
  setTimeout(()=>$('#adminTokenInput').focus(),50);
}
function hideLogin(){const dlg=$('#loginDialog');if(dlg.open)dlg.close();}
async function api(path, options={}){
  const headers={'Content-Type':'application/json',...(options.headers||{})};
  if(adminToken) headers.Authorization=`Bearer ${adminToken}`;
  const res=await fetch(`${API_BASE}${path}`,{...options,headers});
  if(res.status===401){adminToken='';localStorage.removeItem(TOKEN_KEY);showLogin('접근키를 확인해 주세요.');throw new Error('관리자 접근키가 필요합니다.')}
  if(!res.ok){let m=`요청 실패 (${res.status})`,data=null;try{data=await res.json();m=data.error||m}catch{}const err=new Error(m);err.status=res.status;err.data=data;throw err}
  if(res.status===204)return null;
  return res.json();
}
async function refresh(){
  if(!adminToken){showLogin();return;}
  try{snapshot=await api('/api/snapshot');lastFetched=Date.now();render();hideLogin();}
  catch(e){if(adminToken){toast(e.message);$('#refreshAge').textContent='연결 오류';}}
}

function bytes(v){v=Number(v||0);if(!v)return '0 B';const u=['B','KB','MB','GB','TB'];let i=0;while(v>=1024&&i<u.length-1){v/=1024;i++}return `${v>=10||i===0?v.toFixed(0):v.toFixed(1)} ${u[i]}`;}
function actionDuration(seconds){seconds=Math.max(0,Number(seconds||0));if(seconds<60)return `${Math.floor(seconds)}초`;if(seconds<3600)return `${Math.floor(seconds/60)}분 ${Math.floor(seconds%60)}초`;return `${Math.floor(seconds/3600)}시간 ${Math.floor((seconds%3600)/60)}분`;}
function actionStateLabel(s){return ({queued:'QUEUED',in_progress:'RUNNING',success:'SUCCESS',failure:'FAILURE',unknown:'미확인'})[s]||String(s||'미확인').toUpperCase();}
function actionSeverityClass(s){if(['failure','error','offline'].includes(s))return 'failure';if(['queued','warning'].includes(s))return 'queued';if(['in_progress','busy'].includes(s))return 'in_progress';if(['success','normal','idle'].includes(s))return 'success';return 'unknown';}
function setMonitorMode(mode){
  monitorMode=mode==='actions'?'actions':'operations';
  document.body.classList.toggle('monitor-mode-operations',monitorMode==='operations');
  document.body.classList.toggle('monitor-mode-actions',monitorMode==='actions');
  const ops=$('#monitorTabOperations'),actions=$('#monitorTabActions');
  if(ops){ops.classList.toggle('active',monitorMode==='operations');ops.setAttribute('aria-selected',monitorMode==='operations'?'true':'false')}
  if(actions){actions.classList.toggle('active',monitorMode==='actions');actions.setAttribute('aria-selected',monitorMode==='actions'?'true':'false')}
  if(monitorMode==='actions')refreshActions(false);
}
function notifyActionTransitions(next){
  if(!actionsStateReady||!actionsPrevious){actionsStateReady=true;actionsPrevious=next;return;}
  const prev=actionsPrevious||{},notices=[];
  const prevQueue=new Set((prev.queue||[]).map(q=>String(q.job_id||`${q.repository}:${q.run_id}:${q.name}`)));
  const added=(next.queue||[]).filter(q=>!prevQueue.has(String(q.job_id||`${q.repository}:${q.run_id}:${q.name}`)));
  if(added.length===1){const q=added[0];notices.push({type:'queued',text:`Actions 큐 진입 · ${q.repository} · ${q.name}`})}
  else if(added.length>1){notices.push({type:'queued',text:`Actions 큐 ${added.length}건 진입 · ${added.slice(0,2).map(q=>q.repository).join(', ')}${added.length>2?' 외':''}`})}
  const prevRepos=new Map((prev.repositories||[]).map(r=>[r.full_name,r]));
  const completed=[];
  for(const cur of (next.repositories||[])){
    if(!['success','failure'].includes(cur.status))continue;
    const old=prevRepos.get(cur.full_name);if(!old)continue;
    const sameRun=Number(cur.run_id||0)===Number(old.run_id||0);
    const wasActive=['queued','in_progress'].includes(old.status);
    const prevGenerated=dateValue(prev.generated_at),created=dateValue(cur.created_at);
    const completedBetweenPolls=!sameRun&&created&&prevGenerated&&created>prevGenerated;
    if((sameRun&&wasActive)||completedBetweenPolls)completed.push(cur);
  }
  if(completed.length===1){const r=completed[0];notices.push({type:r.status==='failure'?'failure':'success',text:`Actions 완료 · ${r.full_name} · ${actionStateLabel(r.status)}`})}
  else if(completed.length>1){const failures=completed.filter(r=>r.status==='failure').length;notices.push({type:failures?'failure':'success',text:`Actions ${completed.length}건 완료${failures?` · 실패 ${failures}`:''}`})}
  actionsPrevious=next;
  if(notices.length){const type=notices.some(n=>n.type==='failure')?'failure':notices.some(n=>n.type==='queued')?'queued':'success';toast(notices.map(n=>n.text).join(' / '),type,5000);}
}
function renderActions(){
  const a=actionsSnapshot||{},sum=a.summary||{},runner=a.target_runner||null,queue=a.queue||[],failures=a.recent_failures||[],repos=a.repositories||[];
  const meta=$('#actionsMeta');if(!meta)return;
  const rate=a.rate_remaining?` · API 잔여 ${a.rate_remaining}`:'';
  meta.textContent=a.generated_at?`${a.org||'suaveforge'} · ${since(a.generated_at)} 갱신${rate}${a.message?` · ${a.message}`:''}`:`${a.org||'suaveforge'} Actions 상태 확인 대기${a.message?` · ${a.message}`:''}`;
  $('#actionsRepoCount').textContent=sum.repositories||0;$('#actionsQueuedCount').textContent=sum.queued||0;$('#actionsRunningCount').textContent=sum.in_progress||0;$('#actionsSuccessCount').textContent=sum.success||0;$('#actionsFailureCount').textContent=sum.failure||0;
  const tabBadge=$('#actionsTabBadge'),tabActive=Number(sum.queued||0)+Number(sum.in_progress||0);if(tabBadge){tabBadge.textContent=String(tabActive);tabBadge.hidden=tabActive===0;}
  $('#actionsRunnerName').textContent=a.target_runner_name||'123-suaveforge-org-01';
  const runnerState=$('#actionsRunnerState'),runnerPanel=$('#actionsRunnerPanel'),current=$('#actionsRunnerCurrent');
  let rst='unknown',rlabel='미검출';
  if(runner){if(String(runner.status).toLowerCase()!=='online'){rst='offline';rlabel='OFFLINE'}else if(runner.busy){rst='busy';rlabel='BUSY'}else{rst='idle';rlabel='IDLE'}}
  runnerState.className=`actions-state ${actionSeverityClass(rst)}`;runnerState.textContent=rlabel;runnerPanel.classList.toggle('critical',rst==='offline');
  if(!runner){current.className='actions-panel-body muted';current.textContent=a.token_state==='permission_error'?'runner 조회 권한 확인 필요':'조직 runner 목록에서 대상 runner를 찾지 못했습니다.'}
  else if(runner.current_job){current.className='actions-panel-body';current.innerHTML=`<div class="runner-current"><strong>${esc(runner.current_repository)} · ${esc(runner.current_job)}</strong><small>${esc(runner.current_workflow||'workflow')} · 실행 ${actionDuration(runner.current_seconds)}</small><div class="runner-current-meta"><span>${esc(runner.os||'-')}</span><span>RUN #${esc(runner.current_run_id||'-')}</span><span>JOB ${esc(runner.current_job_id||'-')}</span></div></div>`}
  else{current.className='actions-panel-body muted';current.innerHTML=`${runner.busy?'BUSY · 현재 job 매핑 재확인 중':'현재 점유 작업 없음'}<div class="runner-current-meta"><span>${esc(runner.os||'-')}</span><span>${esc((runner.labels||[]).join(' · ')||'labels 없음')}</span></div>`}
  const targetQueue=queue.filter(q=>q.targets_target_runner),otherQueue=queue.filter(q=>!q.targets_target_runner);
  const ordered=[...targetQueue,...otherQueue];$('#actionsQueueState').className=`actions-state ${ordered.some(q=>q.long_queued)?'queued':'unknown'}`;$('#actionsQueueState').textContent=`${targetQueue.length} / 전체 ${queue.length}`;
  $('#actionsQueueList').innerHTML=ordered.length?ordered.map(q=>{const sev=Number(q.wait_seconds||0)>=1200?'critical':q.long_queued?'long':'';const target=q.targets_target_runner?'123 runner':'다른 runner';return `<div class="actions-list-item ${sev}"><span class="queue-index">${q.target_queue_position||q.queue_position||'-'}</span><div><strong>${esc(q.repository)} · ${esc(q.name)}</strong><small>${esc(q.workflow||'workflow')} · ${target} · 대기 ${actionDuration(q.wait_seconds)}</small><small class="cause">${esc(q.reason||'원인 확인 중')}</small></div></div>`}).join(''):'<div class="actions-empty">queued job 없음</div>';
  $('#actionsFailureState').className=`actions-state ${failures.length?'failure':'success'}`;$('#actionsFailureState').textContent=String(failures.length);
  $('#actionsFailureList').innerHTML=failures.length?failures.map(f=>`<div class="actions-list-item failure-item"><div><strong>${esc(f.repository)} · ${esc(f.failed_job||f.workflow||'workflow')}</strong><small>${f.completed_at?since(f.completed_at):'-'} · ${esc(f.conclusion||'failure')}</small><small class="cause">${esc(f.cause||'실패 원인 확인 중')}</small>${f.run_url?`<small><a href="${esc(f.run_url)}" target="_blank" rel="noreferrer">GitHub run 열기 ↗</a></small>`:''}</div></div>`).join(''):'<div class="actions-empty">최근 실패 없음</div>';
  $('#actionsRepoRows').innerHTML=repos.length?repos.map(r=>`<div class="actions-repo-row"><span><strong>${esc(r.full_name)}</strong><small>${esc(r.visibility||'')} · #${esc(r.run_number||'-')}</small></span><span><strong>${esc(r.workflow||'workflow')}</strong><small>${esc(r.branch||'-')} · ${esc(r.event||'-')}</small></span><span><em class="actions-run-pill ${esc(r.status||'unknown')}">${actionStateLabel(r.status)}</em></span><span><strong>${r.status==='queued'?`대기 ${actionDuration(r.queue_seconds)}`:`실행 ${actionDuration(r.duration_seconds)}`}</strong><small>${esc(r.conclusion||'')}</small></span><span><strong>${r.updated_at?since(r.updated_at):'-'}</strong>${r.run_url?`<small><a href="${esc(r.run_url)}" target="_blank" rel="noreferrer">run ↗</a></small>`:''}</span></div>`).join(''):'<div class="actions-empty">최근 Actions run이 있는 repo가 없습니다.</div>';
}
async function refreshActions(force=false){if(!adminToken)return;try{const next=await api(force?'/api/actions/recheck':'/api/actions/snapshot',{method:force?'POST':'GET'});notifyActionTransitions(next);actionsSnapshot=next;actionsLastFetched=Date.now();renderActions()}catch(err){const meta=$('#actionsMeta');if(meta)meta.textContent=`Actions 상태 확인 실패 · ${err.message}`;}}
function pct(v){return `${Number(v||0).toFixed(1)}%`;}
function uptime(v){let s=Math.max(0,Number(v||0));if(!s)return '-';const d=Math.floor(s/86400);s%=86400;const h=Math.floor(s/3600);s%=3600;const m=Math.floor(s/60);if(d)return `${d}일 ${h}시간`;if(h)return `${h}시간 ${m}분`;return `${m}분`;}
function serverFs(path){return (serverSnapshot.filesystems||[]).find(x=>x.path===path)||{};}
function serverStatusLabel(v){return ({running:'RUNNING',down:'DOWN',degraded:'주의',unknown:'미확인',review:'확인 필요',enabled:'등록됨',missing:'미등록',unsupported:'해당 없음',normal:'정상',warning:'주의',critical:'위험'})[v]||v||'-';}
function serverStateClass(v){if(['running','enabled','normal'].includes(v))return 'normal';if(['down','critical'].includes(v))return 'critical';if(['degraded','warning','missing'].includes(v))return 'warning';return 'unknown';}
function clampPct(v){return Math.max(0,Math.min(100,Number(v||0)));}
function metricState(value,warn=80,critical=90){value=Number(value||0);return value>=critical?'critical':value>=warn?'warning':'normal';}
function setMeter(id,value,state){const el=$('#'+id);if(!el)return;const n=clampPct(value);el.style.setProperty('--meter-pct',`${n}%`);el.classList.remove('normal','warning','critical','unknown');el.classList.add(state||'unknown');el.setAttribute('aria-valuenow',n.toFixed(1));}
function captureMetric(key,value){const a=serverMetricHistory[key];if(!a)return;a.push(Number(value||0));if(a.length>28)a.shift();}
function captureServerMetrics(s){const root=(s.filesystems||[]).find(x=>x.path==='/')||{},home=(s.filesystems||[]).find(x=>x.path==='/home')||{};captureMetric('cpu',s.cpu?.usage_percent);captureMetric('ram',s.memory?.used_percent);captureMetric('root',root.used_percent);captureMetric('home',home.used_percent);}
function sparkline(values,state='normal'){const v=(values||[]).slice(-28);if(v.length<2)return '';const w=104,h=28,p=2;const points=v.map((x,i)=>`${(i/(v.length-1)*(w-p*2)+p).toFixed(1)},${(h-p-clampPct(x)/100*(h-p*2)).toFixed(1)}`).join(' ');return `<svg class="sparkline ${esc(state)}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${points}"></polyline></svg>`;}
function serviceGroupState(items){if(items.some(v=>v.status==='down'))return 'critical';if(items.some(v=>v.status==='degraded'||v.auto_start_status==='missing'))return 'warning';if(items.some(v=>['unknown','review'].includes(v.status)||['review','unknown'].includes(v.auto_start_status)))return 'unknown';return 'normal';}
function actionCard(state,title,detail){return `<div class="action-item ${esc(state)}"><span class="action-beacon"></span><div><strong>${esc(title)}</strong><small>${esc(detail)}</small></div></div>`;}
function pgInstanceHTML(inst){const ratio=inst.max_connections?inst.connections/inst.max_connections*100:0;const state=!inst.running?'critical':!inst.connect_ok?'critical':metricState(ratio,70,90);const label=inst.port?`:${inst.port}`:(inst.unit||'local');return `<div class="pg-instance ${state}"><div class="pg-instance-head"><span><strong>${esc(inst.name||'PostgreSQL')}</strong><small>${esc(label)}</small></span><em class="compact-state ${state}">${inst.running?(inst.connect_ok?'연결 정상':'연결 실패'):'DOWN'}</em></div><div class="pg-connection-row"><span>connections ${inst.connect_ok?`${inst.connections||0}/${inst.max_connections||'-'}`:'-'}</span><span>${inst.connect_ok?bytes(inst.total_db_bytes):esc(inst.message||'확인 필요')}</span></div><div class="mini-meter ${state}" style="--meter-pct:${clampPct(ratio)}%"><i></i></div></div>`;}
function serviceRowHTML(v){const ports=(v.ports||[]).join(', ')||v.port||'-';const health=v.health_url?`${v.health_status==='normal'?'✓':'!'} ${v.health_http_status||''}`:'-';const control=v.control_enabled?`<button class="mini-action service-action" data-service="${esc(v.id)}" data-action="start">START</button><button class="mini-action service-action" data-service="${esc(v.id)}" data-action="stop">STOP</button><button class="mini-action service-action" data-service="${esc(v.id)}" data-action="restart">RESTART</button>`:`<span class="service-review" title="${esc(v.message||'확인 필요')}">확인 필요</span>`;return `<div class="server-service-head compact"><span>프로세스</span><span>방식</span><span>상태</span><span>PID · Uptime</span><span>Port / Health</span><span>자동시작</span><span>제어</span></div><div class="server-service-row"><span><strong>${esc(v.name||v.manager_ref)}</strong><small>${esc(v.discovered_from||v.message||'')}</small></span><span>${esc(v.manager)}<small>${esc(v.manager_ref)}</small></span><span><em class="service-state ${serverStateClass(v.status)}">${esc(serverStatusLabel(v.status))}</em><button class="service-log-button" data-service-errors="${esc(v.id)}" data-service-name="${esc(v.name||v.manager_ref)}">로그</button></span><span>${v.pid||'-'}<small>${uptime(v.uptime_seconds)}</small></span><span>${esc(String(ports))}<small>${esc(health)}</small></span><span><em class="service-state ${serverStateClass(v.auto_start_status)}" title="${esc(v.auto_start_message||'')}">${esc(serverStatusLabel(v.auto_start_status))}</em></span><span class="service-controls">${control}</span></div>`;}
function serviceGroupHTML(group,projectById){const items=group.items,state=serviceGroupState(items),p=projectById.get(group.projectId),name=p?.name||(group.projectId==='system'?'SYSTEM':'미분류'),running=items.filter(x=>x.status==='running').length,auto=items.filter(x=>x.auto_start_status==='enabled').length,open=state!=='normal';return `<details class="service-project-group ${state}" ${open?'open':''}><summary><span class="group-status-dot ${state}"></span><span class="group-project"><strong>${esc(name)}</strong><small>${esc(group.projectId)}</small></span><span class="group-stat"><b>${running}/${items.length}</b> RUNNING</span><span class="group-stat"><b>${auto}/${items.length}</b> 자동시작</span><em class="compact-state ${state}">${state==='normal'?'정상':state==='critical'?'장애':state==='warning'?'주의':'확인 필요'}</em><span class="group-chevron">›</span></summary><div class="service-group-body">${items.map(serviceRowHTML).join('')}</div></details>`;}
function renderServer(){
  const s=serverSnapshot||{},cpu=s.cpu||{},mem=s.memory||{},pg=s.postgresql||{},docker=s.docker_runtime||{},sum=s.summary||{},root=serverFs('/'),home=serverFs('/home');
  $('#serverMeta').textContent=s.generated_at?`${since(s.generated_at)} 확인 · ${s.discovery_message||'서비스 레지스트리 자동탐지'}`:'서버 상태 확인 대기';

  const cpuState=metricState(cpu.usage_percent,75,90),ramState=metricState(mem.used_percent,75,90),rootState=root.severity||'unknown',homeState=home.severity||'unknown';
  $('#serverCpu').textContent=`${pct(cpu.usage_percent)} · I/O ${pct(cpu.iowait_percent)}`;$('#serverLoad').textContent=`load ${Number(cpu.load1||0).toFixed(2)} / ${Number(cpu.load5||0).toFixed(2)} / ${Number(cpu.load15||0).toFixed(2)} · ${cpu.cores||'-'} cores`;
  $('#serverRam').textContent=`${pct(mem.used_percent)} · ${bytes(mem.used_bytes)} / ${bytes(mem.total_bytes)}`;$('#serverSwap').textContent=`swap ${pct(mem.swap_used_percent)} · ${bytes(mem.swap_used_bytes)} / ${bytes(mem.swap_total_bytes)}`;
  $('#serverRoot').textContent=`${pct(root.used_percent)} · ${bytes(root.used_bytes)} / ${bytes(root.total_bytes)}`;$('#serverRootInode').textContent=`inode ${pct(root.inode_used_percent)}${root.message?` · ${root.message}`:''}`;
  $('#serverHome').textContent=`${pct(home.used_percent)} · ${bytes(home.used_bytes)} / ${bytes(home.total_bytes)}`;$('#serverHomeInode').textContent=`inode ${pct(home.inode_used_percent)}${home.message?` · ${home.message}`:''}`;
  setMeter('serverCpuMeter',cpu.usage_percent,cpuState);setMeter('serverRamMeter',mem.used_percent,ramState);setMeter('serverRootMeter',root.used_percent,rootState);setMeter('serverHomeMeter',home.used_percent,homeState);
  for(const [id,state] of [['cpuMetricCard',cpuState],['ramMetricCard',ramState],['rootFsCard',rootState],['homeFsCard',homeState]]){const el=$('#'+id);if(!el)continue;el.classList.remove('normal','warning','critical','unknown');el.classList.add(state||'unknown')}
  $('#serverCpuTrend').innerHTML=sparkline(serverMetricHistory.cpu,cpuState);$('#serverRamTrend').innerHTML=sparkline(serverMetricHistory.ram,ramState);$('#serverRootTrend').innerHTML=sparkline(serverMetricHistory.root,rootState);$('#serverHomeTrend').innerHTML=sparkline(serverMetricHistory.home,homeState);

  const pgInstances=pg.instances||[];const pgRunning=pgInstances.filter(x=>x.running).length;const pgState=!pg.detected?'unknown':(!pg.running||!pg.connect_ok)?'critical':'normal';
  $('#serverPg').textContent=!pg.detected?'미검출':pg.connect_ok?`${pgInstances.length||1}개 연결 정상`:pgRunning>0?`${pgRunning}/${pgInstances.length||1} RUNNING`:'DOWN';$('#serverPgDetail').textContent=pg.connect_ok?`${bytes(pg.total_db_bytes)} · connection ${pg.connections||0}/${pg.max_connections||'-'}`:(pg.message||'-');
  $('#serverPgState').className=`compact-state ${pgState}`;$('#serverPgState').textContent=serverStatusLabel(pgState);$('#postgresCard').className=`server-secondary-card ${pgState}`;$('#serverPgInstances').innerHTML=pgInstances.length?pgInstances.map(pgInstanceHTML).join(''):'<div class="server-service-empty">PostgreSQL 인스턴스 없음</div>';

  $('#serverServices').textContent=`${sum.service_running||0}/${sum.service_total||0} RUNNING`;$('#serverAutostart').textContent=`자동시작 ${sum.autostart_enabled||0} · 미등록 ${sum.autostart_missing||0} · 확인필요 ${sum.autostart_review||0}`;
  $('#autoEnabledBar').textContent=sum.autostart_enabled||0;$('#autoMissingBar').textContent=sum.autostart_missing||0;$('#autoReviewBar').textContent=sum.autostart_review||0;
  const dockerState=!docker.installed?'unknown':docker.running?(docker.auto_start_status==='missing'?'warning':'normal'):'critical';
  $('#serverDockerState').className=`compact-state ${dockerState}`;$('#serverDockerState').textContent=!docker.installed?'미검출':docker.running?'RUNNING':'DOWN';
  $('#serverDockerDetail').textContent=docker.message||'격리 Docker runtime 확인 대기';
  const autoBtn=$('#serverAutostartBtn');if(autoBtn&&!autoBtn.disabled)autoBtn.textContent=(docker.installed&&!docker.running&&docker.auto_start_status==='missing')?'Docker 복구 + 자동시작':'미등록 자동시작 설정';
  const serviceState=(sum.service_down||0)>0?'critical':((sum.service_degraded||0)>0||(sum.autostart_missing||0)>0)?'warning':((sum.service_review||0)>0||(sum.service_unknown||0)>0||(sum.autostart_review||0)>0)?'unknown':'normal';
  $('#serverAutoState').className=`compact-state ${serviceState}`;$('#serverAutoState').textContent=serverStatusLabel(serviceState);$('#serviceSummaryCard').className=`server-secondary-card ${serviceState}`;

  const allServices=s.services||[];const warningServices=allServices.filter(v=>v.status==='degraded'||v.auto_start_status==='missing').length;const reviewServices=allServices.filter(v=>['unknown','review'].includes(v.status)||['unknown','review'].includes(v.auto_start_status)).length;
  $('#serverRunningCount').textContent=sum.service_running||0;$('#serverWarningCount').textContent=warningServices;$('#serverDownCount').textContent=sum.service_down||0;$('#serverReviewCount').textContent=reviewServices;const chipValues={serverRunningChip:Number(sum.service_running||0),serverWarningChip:warningServices,serverDownChip:Number(sum.service_down||0),serverReviewChip:reviewServices};for(const [id,n] of Object.entries(chipValues)){const chip=$('#'+id);if(chip)chip.hidden=(n===0&&id!=='serverRunningChip');}
  const machineState=sum.status==='critical'?'critical':sum.status==='warning'?'warning':'normal';const hero=$('#serverHealthHero');hero.className=`server-health-hero ${machineState}`;$('#serverHealthState').textContent=machineState==='critical'?'서버 자체 조치 필요':machineState==='warning'?'서버 자체 주의':'서버 자체 정상';$('#serverHealthDetail').textContent=`123 서버 내부 런타임 · 서비스 ${sum.service_running||0}/${sum.service_total||0} · Docker ${docker.installed?(docker.running?'정상':'DOWN'):'미검출'} · ROOT ${pct(root.used_percent)} · PostgreSQL ${pg.connect_ok?'정상':'확인 필요'}`;

  const actions=[];
  const lastOp=s.last_operation||{};
  if(lastOp.action==='docker-recovery'&&lastOp.status==='failed')actions.push({state:'critical',title:'최근 Docker 자동복구 실패',detail:lastOp.message||'복구 진단 결과 확인 필요'});
  else if(lastOp.action==='docker-recovery'&&lastOp.status==='running')actions.push({state:'warning',title:'Docker 자동복구 진행 중',detail:lastOp.message||'기존 runtime 검증 중'});
  const dockerDownServices=allServices.filter(v=>v.manager==='docker'&&v.status==='down');
  const affectedDockerProjects=[...new Set(dockerDownServices.map(v=>v.project_id).filter(Boolean))];
  const dockerServiceIds=new Set(allServices.filter(v=>v.manager==='docker').map(v=>v.id));
  const failedPgInstances=pgInstances.filter(x=>!x.running||!x.connect_ok);
  const pgBlockedOnlyByDocker=!!(docker.installed&&!docker.running&&failedPgInstances.length&&failedPgInstances.every(x=>x.service_id&&dockerServiceIds.has(x.service_id)));
  if(docker.installed&&!docker.running)actions.push({state:'critical',title:'격리 Docker runtime DOWN',detail:`${docker.message||'/home/ggul-docker runtime DOWN'} · 하위 ${dockerDownServices.length}개 서비스 / ${affectedDockerProjects.length}개 프로젝트 영향`});else if(docker.installed&&docker.running&&docker.auto_start_status==='missing')actions.push({state:'warning',title:'격리 Docker 부팅 자동시작 미등록',detail:docker.auto_start_message||'현재 실행 중이지만 다음 재부팅 복구 관리자 확인 필요'});
  if(root.severity==='critical')actions.push({state:'critical',title:'ROOT 파일시스템 위험',detail:`${pct(root.used_percent)} 사용 · ${root.message||'즉시 정리 필요'}`});else if(root.severity==='warning')actions.push({state:'warning',title:'ROOT 파일시스템 주의',detail:`${pct(root.used_percent)} 사용 · 80% 경고구간`});
  if(home.severity==='critical')actions.push({state:'critical',title:'/home 파일시스템 위험',detail:`${pct(home.used_percent)} 사용 · ${home.message||'즉시 확인'}`});else if(home.severity==='warning')actions.push({state:'warning',title:'/home 파일시스템 주의',detail:`${pct(home.used_percent)} 사용`});
  if(pg.detected&&!pg.connect_ok&&!pgBlockedOnlyByDocker)actions.push({state:'critical',title:'PostgreSQL 연결 확인 필요',detail:pg.message||'실행 인스턴스 연결 실패'});
  if(sum.service_down)actions.push({state:'critical',title:`DOWN 서비스 ${sum.service_down}개`,detail:docker.installed&&!docker.running?`격리 Docker 부모 복구가 먼저 필요 · Docker 하위 ${dockerDownServices.length}개는 개별 START/RESTART 잠금`:'프로젝트별 등록 서비스에서 안전한 START/RESTART 가능'});
  if(sum.service_degraded)actions.push({state:'warning',title:`주의 서비스 ${sum.service_degraded}개`,detail:'재시작 중이거나 실행 상태가 불안정함'});
  if(sum.autostart_missing)actions.push({state:'warning',title:`자동시작 미등록 ${sum.autostart_missing}개`,detail:docker.installed&&docker.auto_start_status==='missing'?'격리 Docker 부모 runtime 포함 · 기존 /home data-root·socket·metadata를 transient 검증한 뒤 일치할 때만 복구/영구등록':'재부팅 복구를 위해 등록 권장'});
  if(sum.autostart_review)actions.push({state:'unknown',title:`자동시작 확인 필요 ${sum.autostart_review}개`,detail:'standalone 등 실행계약 확인 필요'});
  if((s.kernel||{}).oom_detected)actions.push({state:'critical',title:'최근 OOM 흔적',detail:'메모리 부족으로 프로세스 종료 흔적 발견'});if((s.kernel||{}).io_error_detected)actions.push({state:'critical',title:'최근 I/O 오류 흔적',detail:'디스크/파일시스템 오류 로그 확인'});if((s.kernel||{}).hardware_error_detected)actions.push({state:'warning',title:'MCE/EDAC 흔적',detail:'하드웨어 오류 로그 확인'});
  for(const l of (s.logs||[]).filter(x=>x.growth_state!=='normal').slice(0,3))actions.push({state:l.growth_state,title:'로그 비정상 증가',detail:`${l.path} · ${bytes(l.size_bytes)} · ${bytes(l.growth_bytes_per_minute)}/분`});
  const actionRank={critical:0,warning:1,unknown:2};const shown=actions.sort((a,b)=>(actionRank[a.state]??9)-(actionRank[b.state]??9)).slice(0,5);$('#serverActionCount').textContent=actions.length;$('#serverActionRequired').innerHTML=shown.length?shown.map(x=>actionCard(x.state,x.title,x.detail)).join(''):'<div class="action-clear"><span>✓</span><div><strong>서버 내부 조치 없음</strong><small>123 서버 자원과 런타임 서비스가 정상 범위입니다. 프로젝트 장애는 위 프로젝트 상태에서 별도 집계됩니다.</small></div></div>';
  $('#serverAlerts').innerHTML=actions.filter(x=>x.state==='critical').slice(0,4).map(x=>`<span class="server-alert critical">${esc(x.title)} · ${esc(x.detail)}</span>`).join('');

  const projectById=new Map((snapshot.projects||[]).map(p=>[p.id,p]));let services=(s.services||[]);if(serverAbnormalOnly)services=services.filter(v=>serviceGroupState([v])!=='normal');
  const groups=new Map();for(const v of services){const id=v.project_id||'system';if(!groups.has(id))groups.set(id,{projectId:id,items:[]});groups.get(id).items.push(v)}const groupList=[...groups.values()].sort((a,b)=>{const rank={critical:0,warning:1,unknown:2,normal:3};const d=rank[serviceGroupState(a.items)]-rank[serviceGroupState(b.items)];if(d)return d;return String(projectById.get(a.projectId)?.name||a.projectId).localeCompare(String(projectById.get(b.projectId)?.name||b.projectId),'ko')});$('#serverServiceRows').innerHTML=groupList.length?groupList.map(g=>serviceGroupHTML(g,projectById)).join(''):'<div class="server-service-empty">조건에 맞는 서버 프로세스가 없습니다.</div>';

  const rootTop=s.root_top||[],maxRoot=Math.max(1,...rootTop.map(x=>Number(x.bytes||0)));$('#serverRootTop').innerHTML=rootTop.length?rootTop.map(x=>{const width=Math.max(2,Math.min(100,Number(x.bytes||0)/maxRoot*100));return `<div class="server-log-row normal"><div class="log-name"><span title="${esc(x.path)}">${esc(x.path)}</span><small>ROOT filesystem 상위 경로</small></div><strong>${bytes(x.bytes)}</strong><div class="log-bar normal" style="--meter-pct:${width}%"><i></i></div></div>`}).join(''):'<div class="server-service-empty">점유 원인 집계 대기</div>';
  const logs=s.logs||[],maxLog=Math.max(1,...logs.map(x=>Number(x.size_bytes||0)));$('#serverLogRows').innerHTML=logs.length?logs.slice(0,12).map(l=>{const state=l.growth_state||'normal',width=Math.max(2,Math.min(100,Number(l.size_bytes||0)/maxLog*100));return `<div class="server-log-row ${esc(state)}"><div class="log-name"><span title="${esc(l.path)}">${esc(l.path)}</span><small>${l.growth_bytes_per_minute?`${bytes(l.growth_bytes_per_minute)}/분`:'증가 안정'}</small></div><strong>${bytes(l.size_bytes)}</strong><div class="log-bar ${esc(state)}" style="--meter-pct:${width}%"><i></i></div></div>`}).join(''):'<div class="server-service-empty">표시할 로그가 없습니다.</div>';
  const errs=(s.kernel||{}).recent_errors||[];$('#serverKernelErrors').innerHTML=errs.length?errs.map(x=>`<code>${esc(x)}</code>`).join(''):'<div class="server-service-empty">최근 커널 오류 없음</div>';
}
async function refreshServer(force=false){if(!adminToken)return;try{serverSnapshot=await api(force?'/api/server/recheck':'/api/server/snapshot',{method:force?'POST':'GET'});captureServerMetrics(serverSnapshot);serverLastFetched=Date.now();render()}catch(err){$('#serverMeta').textContent=`서버 상태 확인 실패 · ${err.message}`;}}
async function serverServiceAction(id,action){const label=action.toUpperCase();if((action==='stop'||action==='restart')&&!confirm(`${label} 실행할까? 등록된 이 서비스에만 적용된다.`))return;try{await api(`/api/server/services/${encodeURIComponent(id)}/${action}`,{method:'POST'});toast(`${label} 완료`);await refreshServer(true)}catch(err){toast(err.message)}}
async function showServiceErrors(id,name){const dlg=$('#serviceErrorsDialog');$('#serviceErrorsTitle').textContent=`${name} 최근 오류`;$('#serviceErrorsBody').textContent='확인 중…';dlg.showModal();try{const r=await api(`/api/server/services/${encodeURIComponent(id)}/errors`);$('#serviceErrorsBody').textContent=(r.lines||[]).join('\n')||'최근 오류 로그 없음'}catch(err){$('#serviceErrorsBody').textContent=err.message}}

function summarize(){
  const infos=snapshot.projects.map(projectStatusInfo),states=infos.map(x=>x.state);
  const count=k=>states.filter(s=>s===k).length;
  const normal=count('normal'), degraded=count('degraded'), down=count('down'), unknown=count('unknown');
  const runtimeDownProjects=infos.filter(x=>x.runtime?.state==='down').length;
  $('#projectCount').textContent=snapshot.projects.length;
  const targets=snapshot.projects.flatMap(p=>p.targets||[]);const active=targets.filter(t=>t.enabled&&t.endpoint);
  $('#targetCount').textContent=targets.length;$('#enabledTargetCount').textContent=`${active.length} 활성`;
  const last=active.map(t=>dateValue(t.last_check_at)).filter(Boolean).sort((a,b)=>b-a)[0];
  const next=active.map(t=>dateValue(t.next_check_at)).filter(Boolean).sort((a,b)=>a-b)[0];
  $('#lastCheck').textContent=last?since(last):'아직 없음';$('#nextCheck').textContent=`다음 확인 ${next?countdown(next):'-'}`;
  const overall=$('#overallStatus'),detail=$('#overallDetail');
  if(down){overall.textContent=`프로젝트 장애 ${down}`;overall.style.color='var(--down)'}
  else if(degraded){overall.textContent=`프로젝트 주의 ${degraded}`;overall.style.color='var(--slow)'}
  else if(normal){overall.textContent='프로젝트 정상';overall.style.color='var(--normal)'}
  else{overall.textContent='프로젝트 미확인';overall.style.color='var(--unknown)'}
  const serverDown=Number(serverSnapshot.summary?.service_down||0),hubDown=(snapshot.hubs||[]).filter(h=>h.mode!=='planned'&&h.status==='down').length,dockerDown=!!(serverSnapshot.docker_runtime?.installed&&!serverSnapshot.docker_runtime?.running);
  detail.textContent=`프로젝트 기준 · 정상 ${normal} · 주의 ${degraded} · 장애 ${down} · 미확인 ${unknown}${runtimeDownProjects?` · 서버장애 프로젝트 ${runtimeDownProjects}`:''}${serverDown?` · 서버 DOWN ${serverDown}`:''}${dockerDown?' · Docker 부모 DOWN':''}${hubDown?` · Hub 장애 ${hubDown}`:''}`;
}

function render(){summarize();renderHubOverview();renderRecommendations();renderServer();renderActions();
  const q=$('#search').value.trim().toLowerCase();
  const list=snapshot.projects.filter(p=>{
    const st=projectStatus(p);if(filter!=='all'&&st!==filter)return false;
    if(!q)return true;return [p.id,p.name,p.kind,p.category,p.public_url,p.notes,...infraItems(p).map(([,v])=>v),...(p.hubs||[]).filter(h=>h.enabled).map(h=>hubDef(h.hub_id)?.name||h.hub_id)].join(' ').toLowerCase().includes(q);
  });
  $('#projectList').innerHTML=list.length?list.map(projectHTML).join(''):`<div class="empty">조건에 맞는 프로젝트가 없습니다.</div>`;
  bindRows();
}

function projectHTML(p){
  const info=projectStatusInfo(p),st=info.state,targets=(p.targets||[]).filter(t=>t.enabled&&t.endpoint);
  const last=targets.map(t=>dateValue(t.last_check_at)).filter(Boolean).sort((a,b)=>b-a)[0];
  const next=targets.map(t=>dateValue(t.next_check_at)).filter(Boolean).sort((a,b)=>a-b)[0];
  const front=infraGroup(p,'front'),proxy=infraGroup(p,'proxy'),app=infraGroup(p,'app'),database=infraGroup(p,'database'),tls=infraGroup(p,'tls'),edge=infraGroup(p,'edge');
  const runtimeLine=info.runtime?` · 서버 ${info.runtime.running}/${info.runtime.total}${info.runtime.parentDockerDown?' · Docker 부모 DOWN':''}`:'';
  return `<article class="project ${expanded.has(p.id)?'open':''}" data-project="${esc(p.id)}">
    <div class="project-main" tabindex="0" role="button" aria-expanded="${expanded.has(p.id)}">
      <div class="project-identity"><div class="project-title-row"><span class="status-dot ${st}"></span><span class="project-name">${esc(p.name)}</span><span class="project-id">${esc(p.id)}</span>${p.public_url?`<a class="project-link" href="${esc(p.public_url)}" target="_blank" rel="noreferrer" title="바로 열기">↗</a>`:''}</div><p class="project-kind">${esc(p.category)} · ${esc(p.kind||'구성 미확인')}${esc(runtimeLine)}</p></div>
      ${infraCell(front,infraState(p,'front'))}
      ${infraCell(proxy,infraState(p,'proxy'))}
      ${infraCell(app,infraState(p,'app'))}
      ${infraCell(database,infraState(p,'database'))}
      ${infraCell(tls,infraState(p,'tls'))}
      ${infraCell(edge,infraState(p,'edge'))}
      ${hubCell(p)}
      <span class="status-pill ${st}">${esc(info.label)}</span>
      <div class="timing"><strong>${last?since(last):'확인 전'}</strong><span>${next?`다음 ${countdown(next)}`:'자동 체크 없음'}</span></div>
      <span class="chev">›</span>
    </div>
    <div class="details">${detailsHTML(p)}</div>
  </article>`;
}

function detailsHTML(p){
  const rows=(p.targets||[]).map(t=>`<tr>
    <td><span class="target-name">${esc(t.name)}</span><br><span class="detail-meta">${targetKind(t.kind)} · ${t.interval_seconds}s</span></td>
    <td class="endpoint" title="${esc(t.endpoint)}">${esc(t.endpoint||'미설정')}</td>
    <td><span class="component"><i class="dot ${statusClass(t.status)}"></i>${statusText[t.status]||'미확인'}</span></td>
    <td>${t.response_ms?`${t.response_ms} ms`:'-'}</td>
    <td>${t.last_check_at?since(t.last_check_at):'-'}</td>
    <td>${t.next_check_at?countdown(t.next_check_at):'-'}</td>
    <td><div class="target-actions"><button class="button small check-now" data-target="${esc(t.id)}" ${!t.endpoint?'disabled':''}>지금 확인</button><button class="button small edit-target" data-target="${esc(t.id)}">수정</button><button class="button small delete-target" data-target="${esc(t.id)}">삭제</button></div></td>
  </tr>`).join('');
  return `<div class="detail-head"><div class="detail-meta">${p.public_url?esc(p.public_url):'공개 URL 미확인'}${p.notes?` · ${esc(p.notes)}`:''}</div><div class="detail-actions"><button class="button small edit-project" data-project="${esc(p.id)}">프로젝트 정보</button><button class="button small add-target" data-project="${esc(p.id)}">체크 항목 추가</button></div></div>
  ${rows?`<table class="target-table"><thead><tr><th>항목</th><th>주소</th><th>상태</th><th>응답</th><th>최근</th><th>다음</th><th>관리</th></tr></thead><tbody>${rows}</tbody></table>`:`<div class="empty">아직 체크 항목이 없습니다. 확인된 주소만 추가하세요.</div>`}`;
}

function bindRows(){
  $$('.project-main').forEach(el=>{const toggle=e=>{if(e.target.closest('a,button'))return;const id=el.closest('.project').dataset.project;expanded.has(id)?expanded.delete(id):expanded.add(id);render()};el.onclick=toggle;el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();toggle(e)}}});
  $$('.edit-project').forEach(b=>b.onclick=e=>{e.stopPropagation();openProjectDialog(b.dataset.project)});
  $$('.add-target').forEach(b=>b.onclick=e=>{e.stopPropagation();openTargetDialog(b.dataset.project)});
  $$('.check-now').forEach(b=>b.onclick=async e=>{e.stopPropagation();b.disabled=true;b.textContent='확인 중';try{await api(`/api/targets/${b.dataset.target}/check`,{method:'POST'});toast('즉시 확인을 시작했습니다.');setTimeout(refresh,900)}catch(err){toast(err.message)}finally{setTimeout(()=>{b.disabled=false;b.textContent='지금 확인'},1000)}});
  $$('.edit-target').forEach(b=>b.onclick=e=>{e.stopPropagation();openTargetDialog(null,b.dataset.target)});
  $$('.delete-target').forEach(b=>b.onclick=async e=>{e.stopPropagation();if(!confirm('이 체크 항목을 삭제할까요?'))return;try{await api(`/api/targets/${b.dataset.target}`,{method:'DELETE'});toast('삭제했습니다.');refresh()}catch(err){toast(err.message)}});
  $$('.register-recommendation').forEach(b=>b.onclick=async()=>{if(b.disabled)return;const original=b.textContent;b.disabled=true;b.textContent='URL 재확인 중';try{await api(`/api/recommendations/${encodeURIComponent(b.dataset.recommendation)}/register`,{method:'POST',body:'{}'});toast('URL 재확인 완료 · 실목록에 추가하고 인프라를 확인합니다.');await refresh();setTimeout(refresh,1800)}catch(err){if(err.data?.code==='url_verification_required'){openRecommendationUrlDialog(b.dataset.recommendation,err.data);await refresh()}else toast(err.message)}finally{b.disabled=false;b.textContent=original}});
}

function openRecommendationUrlDialog(id,data={}){
  const dlg=$('#recommendationUrlDialog'),form=$('#recommendationUrlForm');form.reset();form.recommendation_id.value=id;form.public_url.value=data.public_url||snapshot.recommendations.find(r=>r.id===id)?.public_url||'';$('#recommendationUrlMessage').textContent=data.url_message||data.error||'실제 운영 URL을 입력해 주세요.';if(!dlg.open)dlg.showModal();setTimeout(()=>form.public_url.focus(),50);
}
function fillInfraForm(form,x={}){form.infra_frontend.value=x.frontend||'';form.infra_proxy_web.value=x.proxy_web||'';form.infra_app_server.value=x.app_server||'';form.infra_database.value=x.database||'';form.infra_tls.value=x.tls||'';form.infra_edge.value=x.edge||'';}
async function detectProjectInfrastructure(projectId,{quiet=false}={}){
  if(!projectId)return;const form=$('#projectForm'),btn=$('#detectInfraBtn'),status=$('#infraDetectStatus');
  btn.disabled=true;btn.textContent='확인 중';status.textContent='123 런타임 · DNS · HTTP 응답 확인 중…';
  try{const r=await api(`/api/projects/${projectId}/detect-infrastructure`,{method:'POST'});const p=snapshot.projects.find(x=>x.id===projectId);if(p){p.infrastructure=r.infrastructure||{};p.infrastructure_state=r.state||p.infrastructure_state||{};}if(form.project_id.value===projectId)fillInfraForm(form,r.infrastructure||{});const evidence=(r.evidence||[]).join(' · ');status.textContent=evidence||'확정 가능한 인프라 증거를 찾지 못했습니다.';if(!quiet)toast(r.changed?'실제 환경 기준으로 갱신했습니다.':'현재 확인값과 동일합니다.');}
  catch(err){status.textContent=err.message;if(!quiet)toast(err.message)}finally{btn.disabled=false;btn.textContent='실제 환경 자동 확인';}
}
async function detectAllInfrastructure(){
  const btn=$('#detectAllInfraBtn');
  if(!btn||btn.disabled||!snapshot.projects.length)return;
  const ids=snapshot.projects.map(p=>p.id);
  let cursor=0,done=0,changed=0,failed=0;
  btn.disabled=true;
  const original='전체 인프라 확인';
  const update=()=>{btn.textContent=`전체 인프라 확인 ${done}/${ids.length}`;};
  update();
  async function worker(workerIndex){
    if(workerIndex)await new Promise(r=>setTimeout(r,workerIndex*140));
    while(true){
      const index=cursor++;
      if(index>=ids.length)return;
      const id=ids[index];
      try{
        const r=await api(`/api/projects/${id}/detect-infrastructure`,{method:'POST'});
        if(r.changed)changed++;
        const p=snapshot.projects.find(x=>x.id===id);if(p){p.infrastructure=r.infrastructure||p.infrastructure||{};p.infrastructure_state=r.state||p.infrastructure_state||{};}
      }catch{failed++}
      done++;update();render();
      await new Promise(r=>setTimeout(r,140));
    }
  }
  try{
    const workers=Math.min(3,ids.length);
    await Promise.all(Array.from({length:workers},(_,i)=>worker(i)));
    await refresh();
    toast(`전체 인프라 확인 완료 · 갱신 ${changed} · 실패 ${failed}`);
  }finally{
    btn.disabled=false;btn.textContent=original;
  }
}

function fillProjectHubs(form,p){
  const m=hubConnMap(p||{});
  for(const id of ['auth','pay','localize']){
    const c=m[id]||{},h=hubDef(id),input=form[`hub_${id}_enabled`];
    input.checked=!!c.enabled;
    input.indeterminate=!!(h?.mode==='active'&&h?.sync_status==='down'&&(!c.source||c.source==='sync-error'));
    form[`hub_${id}_probe`].value=c.probe_url||'';
    const st=h?.mode==='planned'?'planned':((c.status==='sync_error'||h?.sync_status==='down')?'sync_error':(c.enabled?(c.status||h?.status||'unknown'):'disabled'));
    const el=document.querySelector(`[data-hub-project-status="${id}"]`);
    if(el){el.textContent=statusText[st]||st;el.title=c.message||h?.sync_message||'';}
  }
}
function projectHubsFromForm(form){return ['auth','pay','localize'].map(id=>({hub_id:id,enabled:form[`hub_${id}_enabled`].checked,probe_url:form[`hub_${id}_probe`].value.trim(),status:form[`hub_${id}_enabled`].checked?'unknown':'disabled'}));}
async function syncProjectHubs(projectId,desired,current){const before=hubConnMap(current||{}),errors=[];for(const d of desired){const h=hubDef(d.hub_id);if(!h||h.mode!=='active'){if(d.enabled)errors.push(`${h?.name||d.hub_id}: 아직 활성 Hub가 아닙니다.`);continue}const prev=before[d.hub_id]||{};if(!!prev.enabled===!!d.enabled&&String(prev.probe_url||'').trim()===String(d.probe_url||'').trim())continue;try{await api(`/api/projects/${encodeURIComponent(projectId)}/hubs/${encodeURIComponent(d.hub_id)}`,{method:'PUT',body:JSON.stringify({enabled:!!d.enabled,probe_url:d.probe_url||''})})}catch(err){errors.push(`${h.name}: ${err.message}`)}}return errors;}
function openHubDialog(){
  const rows=$('#hubSettingsRows');
  rows.innerHTML=(snapshot.hubs||[]).map(h=>`<div class="hub-setting" data-hub-setting="${esc(h.id)}"><div class="hub-setting-head"><strong>${esc(h.name)}</strong><select name="hub_mode_${esc(h.id)}"><option value="active" ${h.mode==='active'?'selected':''}>활성</option><option value="planned" ${h.mode==='planned'?'selected':''}>예정</option></select></div><label>공개 URL<input name="hub_public_${esc(h.id)}" type="url" value="${esc(h.public_url||'')}" placeholder="https://..."></label><label>Health URL<input name="hub_health_${esc(h.id)}" type="url" value="${esc(h.health_url||'')}" placeholder="https://.../health"></label><label>연결 동기화 API<input name="hub_sync_${esc(h.id)}" type="url" value="${esc(h.sync_url||'')}" placeholder="https://.../api/integration/projects"></label></div>`).join('');
  $('#hubDialog').showModal();
}

function openProjectDialog(projectId=''){
  const form=$('#projectForm');form.reset();form.project_id.value=projectId;$('#projectDialogTitle').textContent=projectId?'프로젝트 정보':'프로젝트 추가';$('#infraDetectStatus').textContent=projectId?'123 런타임 · DNS · HTTP 응답을 확인합니다.':'프로젝트 저장 후 자동 확인할 수 있습니다.';$('#detectInfraBtn').disabled=!projectId;
  let p=null;if(projectId){p=snapshot.projects.find(x=>x.id===projectId);if(p){form.name.value=p.name||'';form.category.value=p.category||'운영';form.kind.value=p.kind||'';form.public_url.value=p.public_url||'';form.notes.value=p.notes||'';fillInfraForm(form,p.infrastructure||{});}}fillProjectHubs(form,p||{});
  $('#projectDialog').showModal();
}

function openTargetDialog(projectId,targetId=''){
  const form=$('#targetForm');form.reset();form.project_id.value=projectId||'';form.target_id.value=targetId;form.interval_seconds.value=120;form.timeout_ms.value=3000;form.critical.checked=true;form.enabled.checked=true;
  $('#targetDialogTitle').textContent=targetId?'체크 항목 수정':'체크 항목 추가';
  if(targetId){const t=snapshot.projects.flatMap(p=>p.targets||[]).find(x=>x.id===targetId);if(t){form.project_id.value=t.project_id;['name','kind','endpoint','interval_seconds','timeout_ms'].forEach(k=>form[k].value=t[k]??'');form.critical.checked=!!t.critical;form.enabled.checked=!!t.enabled}}
  $('#targetDialog').showModal();
}

$('#search').addEventListener('input',render);
$$('.filter').forEach(b=>b.onclick=()=>{$$('.filter').forEach(x=>x.classList.remove('active'));b.classList.add('active');filter=b.dataset.filter;render()});
$('#addProjectBtn').onclick=()=>openProjectDialog();
$('#detectAllInfraBtn').addEventListener('click',detectAllInfrastructure);
$('#hubSettingsBtn').addEventListener('click',openHubDialog);
$('#checkHubsBtn').addEventListener('click',async()=>{const b=$('#checkHubsBtn');b.disabled=true;b.textContent='확인 중';try{await api('/api/hubs/check',{method:'POST'});await refresh();toast('허브 상태를 갱신했습니다.')}catch(err){toast(err.message)}finally{b.disabled=false;b.textContent='허브 확인'}});
$('#discoverNowBtn').addEventListener('click',async()=>{const b=$('#discoverNowBtn');b.disabled=true;b.textContent='탐지 중';try{snapshot=await api('/api/recommendations/discover',{method:'POST'});render();toast('새 프로젝트 탐지를 완료했습니다.')}catch(err){toast(err.message)}finally{b.disabled=false;b.textContent='새 프로젝트 찾기'}});
$('#projectForm').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,f=new FormData(form);try{const id=f.get('project_id');const current=id?snapshot.projects.find(p=>p.id===id):null;const desiredHubs=projectHubsFromForm(form);const body={name:f.get('name'),category:f.get('category'),kind:f.get('kind'),public_url:f.get('public_url'),notes:f.get('notes'),monitorable:current?current.monitorable:!!f.get('public_url'),enabled:current?current.enabled:true,infrastructure:{frontend:f.get('infra_frontend')||'',proxy_web:f.get('infra_proxy_web')||'',app_server:f.get('infra_app_server')||'',database:f.get('infra_database')||'',tls:f.get('infra_tls')||'',edge:f.get('infra_edge')||''}};const p=id?await api(`/api/projects/${id}`,{method:'PUT',body:JSON.stringify(body)}):await api('/api/projects',{method:'POST',body:JSON.stringify(body)});if(!id&&p.public_url){await api(`/api/projects/${p.id}/targets`,{method:'POST',body:JSON.stringify({name:'Public',kind:'http',endpoint:p.public_url,interval_seconds:120,timeout_ms:3000,critical:true,enabled:true})})}const hubErrors=await syncProjectHubs(p.id,desiredHubs,current);await refresh();if(hubErrors.length){toast(`프로젝트 정보는 저장됨 · Hub DB 동기화 실패: ${hubErrors.join(' / ')}`);return}$('#projectDialog').close();toast(id?'프로젝트 정보와 Hub DB를 동기화했습니다.':'프로젝트를 추가하고 Hub DB를 동기화했습니다.')}catch(err){toast(err.message)}});
$('#detectInfraBtn').addEventListener('click',()=>{const id=$('#projectForm').project_id.value;if(id)detectProjectInfrastructure(id);});
$('#targetForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget);const body={name:f.get('name'),kind:f.get('kind'),endpoint:f.get('endpoint'),interval_seconds:Number(f.get('interval_seconds')),timeout_ms:Number(f.get('timeout_ms')),critical:f.get('critical')==='on',enabled:f.get('enabled')==='on'};try{const id=f.get('target_id');if(id)await api(`/api/targets/${id}`,{method:'PUT',body:JSON.stringify(body)});else await api(`/api/projects/${f.get('project_id')}/targets`,{method:'POST',body:JSON.stringify(body)});$('#targetDialog').close();toast(id?'수정했습니다.':'체크 항목을 추가했습니다.');refresh()}catch(err){toast(err.message)}});

$('#cancelRecommendationUrlBtn').addEventListener('click',()=>$('#recommendationUrlDialog').close());$('#closeRecommendationUrlBtn').addEventListener('click',()=>$('#recommendationUrlDialog').close());
$('#recommendationUrlForm').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,f=new FormData(form),btn=form.querySelector('button[type=submit]'),id=f.get('recommendation_id'),publicURL=String(f.get('public_url')||'').trim();if(!id||!publicURL)return;btn.disabled=true;btn.textContent='URL 확인 중';try{await api(`/api/recommendations/${encodeURIComponent(id)}/register`,{method:'POST',body:JSON.stringify({public_url:publicURL})});$('#recommendationUrlDialog').close();toast('URL 확인 완료 · 실목록에 추가하고 인프라를 확인합니다.');await refresh();setTimeout(refresh,1800)}catch(err){if(err.data?.code==='url_verification_required'){$('#recommendationUrlMessage').textContent=err.data.url_message||err.message;if(err.data.public_url)form.public_url.value=err.data.public_url}else toast(err.message)}finally{btn.disabled=false;btn.textContent='다시 확인 후 등록'}});

$('#hubForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget),btn=e.currentTarget.querySelector('button[type=submit]');btn.disabled=true;btn.textContent='저장 중';try{for(const h of (snapshot.hubs||[])){await api(`/api/hubs/${h.id}`,{method:'PUT',body:JSON.stringify({name:h.name,mode:f.get(`hub_mode_${h.id}`),public_url:f.get(`hub_public_${h.id}`)||'',health_url:f.get(`hub_health_${h.id}`)||'',sync_url:f.get(`hub_sync_${h.id}`)||''})})}await api('/api/hubs/check',{method:'POST'});$('#hubDialog').close();await refresh();toast('허브 설정과 상태를 갱신했습니다.')}catch(err){toast(err.message)}finally{btn.disabled=false;btn.textContent='저장 후 확인'}});

$('#monitorTabOperations').addEventListener('click',()=>setMonitorMode('operations'));
$('#monitorTabActions').addEventListener('click',()=>setMonitorMode('actions'));
$('#actionsRecheckBtn').addEventListener('click',async()=>{const b=$('#actionsRecheckBtn');b.disabled=true;b.textContent='확인 중';try{await refreshActions(true);toast('GitHub Actions 상태를 갱신했습니다.')}finally{b.disabled=false;b.textContent='Actions 재확인'}});
$('#serverRecheckBtn').addEventListener('click',async()=>{const b=$('#serverRecheckBtn');b.disabled=true;b.textContent='점검 중';try{await refreshServer(true);toast('서버 전체 재점검 완료')}finally{b.disabled=false;b.textContent='전체 재점검'}});
$('#serverAbnormalBtn').addEventListener('click',()=>{serverAbnormalOnly=!serverAbnormalOnly;$('#serverAbnormalBtn').classList.toggle('active',serverAbnormalOnly);$('#serverAbnormalBtn').textContent=serverAbnormalOnly?'전체 서비스 보기':'비정상 서비스만';renderServer()});
$('#serverAutostartBtn').addEventListener('click',async()=>{const d=serverSnapshot.docker_runtime||{};const recover=d.installed&&!d.running&&d.auto_start_status==='missing';const msg=recover?'격리 Docker 부모가 내려가 있다. 기존 /home/ggul-docker data-root·socket·persisted container metadata를 먼저 transient 기동으로 검증하고, 정확히 일치할 때만 동일 명령을 systemd에 영구 등록한다. 검증 실패 시 영구 등록하지 않는다. 진행할까?':'확정된 systemd / PM2 / Docker 서비스의 미등록 자동시작만 설정한다. 확인 필요 항목은 건드리지 않는다. 진행할까?';if(!confirm(msg))return;const b=$('#serverAutostartBtn');b.disabled=true;b.textContent=recover?'Docker 검증·복구 중':'설정 중';try{const r=await api('/api/server/autostart/apply',{method:'POST'});serverSnapshot=r.snapshot||serverSnapshot;render();const x=r.result||{};const notes=x.notes||[];const blocked=x.blocked||[];const recovered=notes.find(v=>String(v).includes('복구 완료'));toast(recovered||`자동시작 설정 완료 · 갱신 ${x.updated||0} · 보류 ${x.skipped||0}${blocked.length?' · 확인 필요 있음':''}`)}catch(err){toast(err.message);await refreshServer(true)}finally{b.disabled=false;render()}});
document.addEventListener('click',e=>{const a=e.target.closest('.service-action');if(a){serverServiceAction(a.dataset.service,a.dataset.action);return}const l=e.target.closest('[data-service-errors]');if(l)showServiceErrors(l.dataset.serviceErrors,l.dataset.serviceName||'서비스')});
$('#closeServiceErrorsBtn').addEventListener('click',()=>$('#serviceErrorsDialog').close());

$('#loginForm').addEventListener('submit',async e=>{e.preventDefault();const token=$('#adminTokenInput').value.trim();if(!token)return;adminToken=token;localStorage.setItem(TOKEN_KEY,token);try{await refresh();await refreshServer(true);}catch{}});
$('#changeKeyBtn').addEventListener('click',()=>{adminToken='';localStorage.removeItem(TOKEN_KEY);showLogin('새 접근키를 입력해 주세요.');});
setInterval(()=>{if(lastFetched)$('#refreshAge').textContent=`${Math.floor((Date.now()-lastFetched)/1000)}초 전`;if(snapshot.projects.length){summarize();$$('.project').forEach(el=>{});}},1000);
setInterval(refresh,5000);
setInterval(()=>refreshServer(false),15000);
setInterval(()=>{if(!document.hidden)refreshActions(false)},ACTIONS_POLL_MS);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshActions(false)});
setMonitorMode('operations');
refresh();
refreshServer(true);
refreshActions(true);
