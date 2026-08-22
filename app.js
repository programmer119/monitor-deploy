const API_BASE = 'https://api-monitor.suaveforge.com';
const TOKEN_KEY = 'suaveforge-monitor-admin-token';
let adminToken = localStorage.getItem(TOKEN_KEY) || '';
const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
let snapshot = {projects:[], history:[], updated:null};
let filter = 'all';
let expanded = new Set();
let lastFetched = 0;

const statusText = {normal:'정상', slow:'지연', suspect:'재확인', down:'장애', unknown:'미확인', degraded:'주의'};

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
  if(!res.ok){let m=`요청 실패 (${res.status})`;try{const j=await res.json();m=j.error||m}catch{}throw new Error(m)}
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

function render(){summarize();
  const q=$('#search').value.trim().toLowerCase();
  const list=snapshot.projects.filter(p=>{
    const st=projectStatus(p);if(filter!=='all'&&st!==filter)return false;
    if(!q)return true;return [p.name,p.kind,p.category,p.public_url,p.notes].join(' ').toLowerCase().includes(q);
  });
  $('#projectList').innerHTML=list.length?list.map(projectHTML).join(''):`<div class="empty">조건에 맞는 프로젝트가 없습니다.</div>`;
  bindRows();
}

function projectHTML(p){
  const st=projectStatus(p), targets=(p.targets||[]).filter(t=>t.enabled&&t.endpoint);
  const last=targets.map(t=>dateValue(t.last_check_at)).filter(Boolean).sort((a,b)=>b-a)[0];
  const next=targets.map(t=>dateValue(t.next_check_at)).filter(Boolean).sort((a,b)=>a-b)[0];
  const comps=targets.length?targets.slice(0,5).map(t=>`<span class="component" title="${esc(t.endpoint)}"><i class="dot ${statusClass(t.status)}"></i>${esc(t.name)}${t.response_ms?` <strong>${t.response_ms}ms</strong>`:''}</span>`).join(''):`<span class="component"><i class="dot unknown"></i>체크 항목 없음</span>`;
  return `<article class="project ${expanded.has(p.id)?'open':''}" data-project="${esc(p.id)}">
    <div class="project-main" tabindex="0" role="button" aria-expanded="${expanded.has(p.id)}">
      <div><div class="project-title-row"><span class="status-dot ${st}"></span><span class="project-name">${esc(p.name)}</span>${p.public_url?`<a class="project-link" href="${esc(p.public_url)}" target="_blank" rel="noreferrer" title="바로 열기">↗</a>`:''}</div><p class="project-kind">${esc(p.category)} · ${esc(p.kind||'구성 미확인')}</p></div>
      <div class="components">${comps}</div>
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
  return `<div class="detail-head"><div class="detail-meta">${p.public_url?esc(p.public_url):'공개 URL 미확인'}${p.notes?` · ${esc(p.notes)}`:''}</div><button class="button small add-target" data-project="${esc(p.id)}">체크 항목 추가</button></div>
  ${rows?`<table class="target-table"><thead><tr><th>항목</th><th>주소</th><th>상태</th><th>응답</th><th>최근</th><th>다음</th><th>관리</th></tr></thead><tbody>${rows}</tbody></table>`:`<div class="empty">아직 체크 항목이 없습니다. 확인된 주소만 추가하세요.</div>`}`;
}

function bindRows(){
  $$('.project-main').forEach(el=>{const toggle=e=>{if(e.target.closest('a,button'))return;const id=el.closest('.project').dataset.project;expanded.has(id)?expanded.delete(id):expanded.add(id);render()};el.onclick=toggle;el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();toggle(e)}}});
  $$('.add-target').forEach(b=>b.onclick=e=>{e.stopPropagation();openTargetDialog(b.dataset.project)});
  $$('.check-now').forEach(b=>b.onclick=async e=>{e.stopPropagation();b.disabled=true;b.textContent='확인 중';try{await api(`/api/targets/${b.dataset.target}/check`,{method:'POST'});toast('즉시 확인을 시작했습니다.');setTimeout(refresh,900)}catch(err){toast(err.message)}finally{setTimeout(()=>{b.disabled=false;b.textContent='지금 확인'},1000)}});
  $$('.edit-target').forEach(b=>b.onclick=e=>{e.stopPropagation();openTargetDialog(null,b.dataset.target)});
  $$('.delete-target').forEach(b=>b.onclick=async e=>{e.stopPropagation();if(!confirm('이 체크 항목을 삭제할까요?'))return;try{await api(`/api/targets/${b.dataset.target}`,{method:'DELETE'});toast('삭제했습니다.');refresh()}catch(err){toast(err.message)}});
}

function openTargetDialog(projectId,targetId=''){
  const form=$('#targetForm');form.reset();form.project_id.value=projectId||'';form.target_id.value=targetId;form.interval_seconds.value=120;form.timeout_ms.value=3000;form.critical.checked=true;form.enabled.checked=true;
  $('#targetDialogTitle').textContent=targetId?'체크 항목 수정':'체크 항목 추가';
  if(targetId){const t=snapshot.projects.flatMap(p=>p.targets||[]).find(x=>x.id===targetId);if(t){form.project_id.value=t.project_id;['name','kind','endpoint','interval_seconds','timeout_ms'].forEach(k=>form[k].value=t[k]??'');form.critical.checked=!!t.critical;form.enabled.checked=!!t.enabled}}
  $('#targetDialog').showModal();
}

$('#search').addEventListener('input',render);
$$('.filter').forEach(b=>b.onclick=()=>{$$('.filter').forEach(x=>x.classList.remove('active'));b.classList.add('active');filter=b.dataset.filter;render()});
$('#addProjectBtn').onclick=()=>{$('#projectForm').reset();$('#projectDialog').showModal()};
$('#projectForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{const p=await api('/api/projects',{method:'POST',body:JSON.stringify({name:f.get('name'),category:f.get('category'),kind:f.get('kind'),public_url:f.get('public_url'),notes:f.get('notes'),monitorable:!!f.get('public_url')})});if(p.public_url){await api(`/api/projects/${p.id}/targets`,{method:'POST',body:JSON.stringify({name:'Public',kind:'http',endpoint:p.public_url,interval_seconds:120,timeout_ms:3000,critical:true,enabled:true})})}$('#projectDialog').close();toast('프로젝트를 추가했습니다.');refresh()}catch(err){toast(err.message)}});
$('#targetForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget);const body={name:f.get('name'),kind:f.get('kind'),endpoint:f.get('endpoint'),interval_seconds:Number(f.get('interval_seconds')),timeout_ms:Number(f.get('timeout_ms')),critical:f.get('critical')==='on',enabled:f.get('enabled')==='on'};try{const id=f.get('target_id');if(id)await api(`/api/targets/${id}`,{method:'PUT',body:JSON.stringify(body)});else await api(`/api/projects/${f.get('project_id')}/targets`,{method:'POST',body:JSON.stringify(body)});$('#targetDialog').close();toast(id?'수정했습니다.':'체크 항목을 추가했습니다.');refresh()}catch(err){toast(err.message)}});

$('#loginForm').addEventListener('submit',async e=>{e.preventDefault();const token=$('#adminTokenInput').value.trim();if(!token)return;adminToken=token;localStorage.setItem(TOKEN_KEY,token);try{await refresh();}catch{}});
$('#changeKeyBtn').addEventListener('click',()=>{adminToken='';localStorage.removeItem(TOKEN_KEY);showLogin('새 접근키를 입력해 주세요.');});
setInterval(()=>{if(lastFetched)$('#refreshAge').textContent=`${Math.floor((Date.now()-lastFetched)/1000)}초 전`;if(snapshot.projects.length){summarize();$$('.project').forEach(el=>{});}},1000);
setInterval(refresh,5000);
refresh();
