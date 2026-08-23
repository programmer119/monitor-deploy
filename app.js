const API_BASE = 'https://api-monitor.suaveforge.com';
const TOKEN_KEY = 'suaveforge-monitor-admin-token';
let adminToken = localStorage.getItem(TOKEN_KEY) || '';
const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
let snapshot = {projects:[], history:[], recommendations:[], discovery:{}, hubs:[], updated:null};
let filter = 'all';
let expanded = new Set();
let lastFetched = 0;

const statusText = {normal:'정상', slow:'지연', suspect:'재확인', down:'장애', unknown:'미확인', degraded:'주의', planned:'예정', disabled:'미사용'};

function esc(v=''){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function projectStatus(p){
  const ts=(p.targets||[]).filter(t=>t.enabled && t.endpoint);
  if(!p.enabled || ts.length===0) return 'unknown';
  if(ts.some(t=>t.critical && t.status==='down')) return 'down';
  if(ts.some(t=>['down','suspect','slow'].includes(t.status))) return 'degraded';
  if(ts.every(t=>t.status==='normal')) return 'normal';
  return 'unknown';
}
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
  el.innerHTML=(snapshot.hubs||[]).map(h=>{const st=h.mode==='planned'?'planned':(h.status||'unknown');const detail=h.mode==='planned'?'추가 예정':(h.last_check_at?`${h.response_ms||'-'} ms · ${since(h.last_check_at)}`:'확인 대기');return `<article class="hub-card"><div class="hub-card-title"><span class="dot ${statusClass(st)}"></span><strong>${esc(h.name)}</strong><span class="hub-mode ${esc(st)}">${esc(statusText[st]||st)}</span></div><div class="hub-url">${h.public_url?`<a href="${esc(h.public_url)}" target="_blank" rel="noreferrer">${esc(h.public_url)}</a>`:'URL 미등록'}</div><small>${esc(detail)}</small></article>`}).join('');
}
function renderRecommendations(){
  const list=$('#recommendationList'), meta=$('#discoveryMeta');if(!list||!meta)return;
  const d=snapshot.discovery||{}, recs=snapshot.recommendations||[];
  meta.textContent=d.last_error?`마지막 탐지 실패 · ${d.last_error}`:d.last_check_at?`6시간 주기 자동 탐지 · 마지막 ${since(d.last_check_at)} · 후보 ${recs.length}`:'6시간 주기 자동 탐지 · 첫 확인 대기';
  const urlLabels={verified:'URL 확인됨',protected:'접근제한 확인',suspect:'URL 확인 필요',missing:'URL 미확인'};
  list.innerHTML=recs.length?recs.map(r=>{const us=r.url_status||'missing',ul=urlLabels[us]||'URL 미확인';return `<article class="recommendation-item"><div><strong>${esc(r.name)}</strong><span>${esc(r.repository)}</span><div class="recommendation-url-line"><small title="${esc(r.public_url||'')}">${r.public_url?esc(r.public_url):'운영 URL을 찾지 못했습니다.'}</small><em class="url-check ${esc(us)}">${esc(ul)}</em></div>${r.url_message?`<p class="recommendation-url-message">${esc(r.url_message)}</p>`:''}</div><button class="button primary small register-recommendation" data-recommendation="${esc(r.id)}">${us==='verified'||us==='protected'?'등록':'URL 확인 후 등록'}</button></article>`}).join(''):`<div class="recommendation-empty">현재 새로 추천할 프로젝트가 없습니다.</div>`;
}
function toast(msg){const el=$('#toast');el.textContent=msg;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2200);}

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

function summarize(){
  const states=snapshot.projects.map(projectStatus);
  const count=k=>states.filter(s=>s===k).length;
  const normal=count('normal'), degraded=count('degraded'), down=count('down'), unknown=count('unknown');
  $('#projectCount').textContent=snapshot.projects.length;
  const targets=snapshot.projects.flatMap(p=>p.targets||[]);const active=targets.filter(t=>t.enabled&&t.endpoint);
  $('#targetCount').textContent=targets.length;$('#enabledTargetCount').textContent=`${active.length} 활성`;
  const last=active.map(t=>dateValue(t.last_check_at)).filter(Boolean).sort((a,b)=>b-a)[0];
  const next=active.map(t=>dateValue(t.next_check_at)).filter(Boolean).sort((a,b)=>a-b)[0];
  $('#lastCheck').textContent=last?since(last):'아직 없음';$('#nextCheck').textContent=`다음 확인 ${next?countdown(next):'-'}`;
  const overall=$('#overallStatus'),detail=$('#overallDetail');
  if(down){overall.textContent=`장애 ${down}`;overall.style.color='var(--down)'}
  else if(degraded){overall.textContent=`주의 ${degraded}`;overall.style.color='var(--slow)'}
  else if(normal){overall.textContent='정상';overall.style.color='var(--normal)'}
  else{overall.textContent='미확인';overall.style.color='var(--unknown)'}
  detail.textContent=`정상 ${normal} · 주의 ${degraded} · 장애 ${down} · 미확인 ${unknown}`;
}

function render(){summarize();renderHubOverview();renderRecommendations();
  const q=$('#search').value.trim().toLowerCase();
  const list=snapshot.projects.filter(p=>{
    const st=projectStatus(p);if(filter!=='all'&&st!==filter)return false;
    if(!q)return true;return [p.id,p.name,p.kind,p.category,p.public_url,p.notes,...infraItems(p).map(([,v])=>v),...(p.hubs||[]).filter(h=>h.enabled).map(h=>hubDef(h.hub_id)?.name||h.hub_id)].join(' ').toLowerCase().includes(q);
  });
  $('#projectList').innerHTML=list.length?list.map(projectHTML).join(''):`<div class="empty">조건에 맞는 프로젝트가 없습니다.</div>`;
  bindRows();
}

function projectHTML(p){
  const st=projectStatus(p), targets=(p.targets||[]).filter(t=>t.enabled&&t.endpoint);
  const last=targets.map(t=>dateValue(t.last_check_at)).filter(Boolean).sort((a,b)=>b-a)[0];
  const next=targets.map(t=>dateValue(t.next_check_at)).filter(Boolean).sort((a,b)=>a-b)[0];
  const front=infraGroup(p,'front'),proxy=infraGroup(p,'proxy'),app=infraGroup(p,'app'),database=infraGroup(p,'database'),tls=infraGroup(p,'tls'),edge=infraGroup(p,'edge');
  return `<article class="project ${expanded.has(p.id)?'open':''}" data-project="${esc(p.id)}">
    <div class="project-main" tabindex="0" role="button" aria-expanded="${expanded.has(p.id)}">
      <div class="project-identity"><div class="project-title-row"><span class="status-dot ${st}"></span><span class="project-name">${esc(p.name)}</span><span class="project-id">${esc(p.id)}</span>${p.public_url?`<a class="project-link" href="${esc(p.public_url)}" target="_blank" rel="noreferrer" title="바로 열기">↗</a>`:''}</div><p class="project-kind">${esc(p.category)} · ${esc(p.kind||'구성 미확인')}</p></div>
      ${infraCell(front,infraState(p,'front'))}
      ${infraCell(proxy,infraState(p,'proxy'))}
      ${infraCell(app,infraState(p,'app'))}
      ${infraCell(database,infraState(p,'database'))}
      ${infraCell(tls,infraState(p,'tls'))}
      ${infraCell(edge,infraState(p,'edge'))}
      ${hubCell(p)}
      <span class="status-pill ${st}">${statusText[st]}</span>
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
  for(const id of ['auth','pay','localize']){const c=m[id]||{};form[`hub_${id}_enabled`].checked=!!c.enabled;form[`hub_${id}_probe`].value=c.probe_url||'';const h=hubDef(id),st=c.enabled?(c.status||h?.status||'unknown'):(h?.mode==='planned'?'planned':'disabled');const el=document.querySelector(`[data-hub-project-status="${id}"]`);if(el)el.textContent=statusText[st]||st;}
}
function projectHubsFromForm(form){return ['auth','pay','localize'].map(id=>({hub_id:id,enabled:form[`hub_${id}_enabled`].checked,probe_url:form[`hub_${id}_probe`].value.trim(),status:form[`hub_${id}_enabled`].checked?'unknown':'disabled'}));}
function openHubDialog(){
  const rows=$('#hubSettingsRows');
  rows.innerHTML=(snapshot.hubs||[]).map(h=>`<div class="hub-setting" data-hub-setting="${esc(h.id)}"><div class="hub-setting-head"><strong>${esc(h.name)}</strong><select name="hub_mode_${esc(h.id)}"><option value="active" ${h.mode==='active'?'selected':''}>활성</option><option value="planned" ${h.mode==='planned'?'selected':''}>예정</option></select></div><label>공개 URL<input name="hub_public_${esc(h.id)}" type="url" value="${esc(h.public_url||'')}" placeholder="https://..."></label><label>Health URL<input name="hub_health_${esc(h.id)}" type="url" value="${esc(h.health_url||'')}" placeholder="https://.../health"></label></div>`).join('');
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
$('#projectForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{const id=f.get('project_id');const current=id?snapshot.projects.find(p=>p.id===id):null;const body={name:f.get('name'),category:f.get('category'),kind:f.get('kind'),public_url:f.get('public_url'),notes:f.get('notes'),monitorable:current?current.monitorable:!!f.get('public_url'),enabled:current?current.enabled:true,infrastructure:{frontend:f.get('infra_frontend')||'',proxy_web:f.get('infra_proxy_web')||'',app_server:f.get('infra_app_server')||'',database:f.get('infra_database')||'',tls:f.get('infra_tls')||'',edge:f.get('infra_edge')||''},hubs:projectHubsFromForm(e.currentTarget)};const p=id?await api(`/api/projects/${id}`,{method:'PUT',body:JSON.stringify(body)}):await api('/api/projects',{method:'POST',body:JSON.stringify(body)});if(!id&&p.public_url){await api(`/api/projects/${p.id}/targets`,{method:'POST',body:JSON.stringify({name:'Public',kind:'http',endpoint:p.public_url,interval_seconds:120,timeout_ms:3000,critical:true,enabled:true})})}$('#projectDialog').close();toast(id?'프로젝트 정보를 수정했습니다.':'프로젝트를 추가했습니다.');api('/api/hubs/check',{method:'POST'}).then(refresh).catch(()=>refresh())}catch(err){toast(err.message)}});
$('#detectInfraBtn').addEventListener('click',()=>{const id=$('#projectForm').project_id.value;if(id)detectProjectInfrastructure(id);});
$('#targetForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget);const body={name:f.get('name'),kind:f.get('kind'),endpoint:f.get('endpoint'),interval_seconds:Number(f.get('interval_seconds')),timeout_ms:Number(f.get('timeout_ms')),critical:f.get('critical')==='on',enabled:f.get('enabled')==='on'};try{const id=f.get('target_id');if(id)await api(`/api/targets/${id}`,{method:'PUT',body:JSON.stringify(body)});else await api(`/api/projects/${f.get('project_id')}/targets`,{method:'POST',body:JSON.stringify(body)});$('#targetDialog').close();toast(id?'수정했습니다.':'체크 항목을 추가했습니다.');refresh()}catch(err){toast(err.message)}});

$('#cancelRecommendationUrlBtn').addEventListener('click',()=>$('#recommendationUrlDialog').close());$('#closeRecommendationUrlBtn').addEventListener('click',()=>$('#recommendationUrlDialog').close());
$('#recommendationUrlForm').addEventListener('submit',async e=>{e.preventDefault();const form=e.currentTarget,f=new FormData(form),btn=form.querySelector('button[type=submit]'),id=f.get('recommendation_id'),publicURL=String(f.get('public_url')||'').trim();if(!id||!publicURL)return;btn.disabled=true;btn.textContent='URL 확인 중';try{await api(`/api/recommendations/${encodeURIComponent(id)}/register`,{method:'POST',body:JSON.stringify({public_url:publicURL})});$('#recommendationUrlDialog').close();toast('URL 확인 완료 · 실목록에 추가하고 인프라를 확인합니다.');await refresh();setTimeout(refresh,1800)}catch(err){if(err.data?.code==='url_verification_required'){$('#recommendationUrlMessage').textContent=err.data.url_message||err.message;if(err.data.public_url)form.public_url.value=err.data.public_url}else toast(err.message)}finally{btn.disabled=false;btn.textContent='다시 확인 후 등록'}});

$('#hubForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget),btn=e.currentTarget.querySelector('button[type=submit]');btn.disabled=true;btn.textContent='저장 중';try{for(const h of (snapshot.hubs||[])){await api(`/api/hubs/${h.id}`,{method:'PUT',body:JSON.stringify({name:h.name,mode:f.get(`hub_mode_${h.id}`),public_url:f.get(`hub_public_${h.id}`)||'',health_url:f.get(`hub_health_${h.id}`)||''})})}await api('/api/hubs/check',{method:'POST'});$('#hubDialog').close();await refresh();toast('허브 설정과 상태를 갱신했습니다.')}catch(err){toast(err.message)}finally{btn.disabled=false;btn.textContent='저장 후 확인'}});

$('#loginForm').addEventListener('submit',async e=>{e.preventDefault();const token=$('#adminTokenInput').value.trim();if(!token)return;adminToken=token;localStorage.setItem(TOKEN_KEY,token);try{await refresh();}catch{}});
$('#changeKeyBtn').addEventListener('click',()=>{adminToken='';localStorage.removeItem(TOKEN_KEY);showLogin('새 접근키를 입력해 주세요.');});
setInterval(()=>{if(lastFetched)$('#refreshAge').textContent=`${Math.floor((Date.now()-lastFetched)/1000)}초 전`;if(snapshot.projects.length){summarize();$$('.project').forEach(el=>{});}},1000);
setInterval(refresh,5000);
refresh();
