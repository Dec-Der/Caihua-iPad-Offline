/* Caihua Cloud Photo Sync v2.0 (manual, single-task transfers + safe diagnostics) — ONLY images synchronize; annotations stay in device IndexedDB.
   Supabase Auth password + private Storage bucket + per-user row-level access. No secret/service key. */
'use strict';
(()=>{
const $=id=>document.getElementById(id);
const SETTINGS_KEY='caihua_cloud_settings_v1', SESSION_KEY='caihua_cloud_session_v1', BUCKET='caihua-photos', VERIFIED_KEY='caihua_verified_remote_v1';
let settings=null, session=null, busy=false, syncing=false, timer=null;
const display=(msg)=>{ $('cloudStatus').textContent=msg; };
function readStored(){try{return JSON.parse(localStorage.getItem(SETTINGS_KEY)||'null')}catch{return null}}
function validateSettings(s){
 const u=String(s.url||'').trim().replace(/\/$/,'');
 if(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(u))throw Error('Supabase Project URL 必须是 https://项目ID.supabase.co');
 const k=String(s.key||'').trim();
 if(!k||k.startsWith('sb_secret_'))throw Error('仅能填写 publishable 或 anon 公钥，严禁使用 service_role / secret 密钥');
 // Legacy JWT anon/service role keys: reject service_role even if user pastes one.
 if(k.includes('.')){try{const p=JSON.parse(atob(k.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));if(p.role!=='anon')throw Error('只能填写 anon 公钥，不允许 service_role 密钥')}catch(e){if(String(e.message).includes('只能'))throw e}}
 return {url:u,key:k};
}
const jsonHeaders=()=>({'apikey':settings.key,'Content-Type':'application/json'});
function errorFromPayload(obj,status){return new Error(`${obj?.msg||obj?.message||obj?.error_description||obj?.error||`HTTP ${status}`}`)}
// Safari sometimes aborts fetch before an HTTP response is available. Retry ONLY
// transport errors. Never retry rejected credentials (HTTP 400/401).
function isNetworkFailure(err){return err?.name==='AbortError'||/load failed|failed to fetch|networkerror|network request failed|请求超时|网络请求未完成|网络连接失败/i.test(String(err?.message||err))||err instanceof TypeError}
function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
async function timedFetch(url,opts={},timeoutMs=16000){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{return await fetch(url,{...opts,signal:controller.signal})}finally{clearTimeout(timer)}
}
async function retryingFetch(url,opts,label){
  const transferTimeout=opts?.body instanceof Blob?120000:90000;
  for(let attempt=1;attempt<=3;attempt++){
    try{return await timedFetch(url,opts,transferTimeout)}
    catch(e){
      if(!isNetworkFailure(e))throw e;
      if(attempt===3 || (opts?.method==='POST' && !(url.includes('/auth/v1/')) && !(url.includes('/object/list/'))))throw Error(`${label}网络请求未完成（${e.message||e.name}）。请点击「诊断连接」，并检查网络、DNS、Safari 内容拦截或跨域预检。`);
      display(`${label}网络暂时失败，正在重试 ${attempt}/2…`);
      await delay(attempt===1?800:1800);
    }
  }
}
async function authToken(grant,body){
  const r=await retryingFetch(`${settings.url}/auth/v1/token?grant_type=${grant}`,{
    method:'POST',headers:jsonHeaders(),body:JSON.stringify(body),cache:'no-store'
  },grant==='refresh_token'?'续期':'登录');
  const obj=await r.json().catch(()=>({}));
  if(!r.ok)throw errorFromPayload(obj,r.status);
  if(!obj.access_token||!obj.refresh_token||!obj.user?.id)throw Error('无法取得完整认证信息，请重新登录');
  session={access_token:obj.access_token,refresh_token:obj.refresh_token,user:obj.user,expires_at:Date.now()+(obj.expires_in||3600)*1000};
  localStorage.setItem(SESSION_KEY,JSON.stringify(session));renderLogin();return session;
}
// Safe diagnosis never transmits passwords or access tokens, and never logs keys.
async function diagnoseConnection(){
  const out=['云照片库连接诊断 V2.0'];
  try{
    const s=validateSettings({url:$('cloudUrl').value,key:$('cloudKey').value});
    out.push('平台：'+location.origin,'云端主机：'+new URL(s.url).host,'设备在线状态：'+(navigator.onLine?'显示在线':'显示离线'));
    const base=s.url+'/auth/v1/health';
    const test=async(label,headers)=>{
      try{
        const r=await timedFetch(base+'?check='+Date.now(),{method:'GET',headers,cache:'no-store'},12000);
        out.push(`${label}：可收到 HTTP ${r.status}`);return true;
      }catch(e){out.push(`${label}：请求失败（${e?.name||'Error'}：${e?.message||'未知错误'}）`);return false}
    };
    const direct=await test('① 基础跨域 GET（不附加密钥）',{});
    const keyed=await test('② 带 apikey 的 GET（触发预检）',{'apikey':s.key});
    if(!direct&&!keyed)out.push('判断：iPad 浏览器跨域请求受阻；优先尝试切换网络、关闭 Safari 内容拦截，查看是否出现代理或预检重定向。');
    else if(direct&&!keyed)out.push('判断：无密钥请求可用，带 apikey 请求失败；重点排查 OPTIONS 预检、Safari 内容拦截、代理或网络重定向。');
    else if(!direct&&keyed)out.push('判断：带 apikey 的跨域请求可用。无密钥健康检查可能被服务端拒绝，不代表登录必然失败；现在尝试登录。');
    else out.push('判断：基础跨域请求可用；再尝试登录。如仍报 Load failed，请按时间查 Supabase 的 API Gateway / Auth 日志。');
    out.push('本次诊断不读取或更改照片、笔画和 JSON。');
  }catch(e){out.push('配置检查失败：'+e.message)}
  const message=out.join('\n');display('诊断完成（点击云照片库查看结果）');
  $('cloudDiagnosisResult').textContent=message;
  alert(message);
}

async function getSession(){
 if(!settings)throw Error('请先配置云照片库');if(!session)throw Error('请先登录云照片库');
 if(Date.now()>session.expires_at-90_000){
   try{await authToken('refresh_token',{refresh_token:session.refresh_token})}
   catch(err){
     // Crucial: a temporary Safari network outage must NOT delete a valid saved session.
     if(isNetworkFailure(err))throw Error('云端会话刷新遇到网络问题，登录信息已保留；请联网后重试。'+err.message);
     session=null;localStorage.removeItem(SESSION_KEY);renderLogin();
     throw Error('登录已过期或被服务器拒绝，请重新登录：'+err.message);
   }
 }
 return session;
}
async function request(path,options={}){
 const ss=await getSession();
 const h={'apikey':settings.key,'Authorization':`Bearer ${ss.access_token}`,...options.headers};
 const r=await retryingFetch(`${settings.url}/storage/v1/${path}`,{...options,headers:h,cache:'no-store'},'云照片请求');
 if(!r.ok){const body=await r.json().catch(()=>({}));throw errorFromPayload(body,r.status)}
 return r;
}
const encodedPath=name=>session.user.id+'/'+encodeURIComponent(name);
async function listCloud(){
 const all=[];let offset=0;
 for(let page=0;page<1000;page++){
  const r=await request('object/list/'+BUCKET,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefix:session.user.id+'/',limit:100,offset,sortBy:{column:'name',order:'asc'}})});
  const items=await r.json();if(!Array.isArray(items))throw Error('云照片列表返回无效格式');
  for(const it of items){if(it.id!==null&&it.id!==undefined && /\.(png|jpe?g|webp)$/i.test(it.name)) all.push(it.name)}
  if(items.length<100)break;offset+=items.length;
  if(page===999)throw Error('云照片数量超出安全分页限制');
 }
 return all;
}
function localRecord(name){return state.queue.find(q=>q.name.toLowerCase()===name.toLowerCase())}
function readVerified(){try{return JSON.parse(localStorage.getItem(VERIFIED_KEY)||'{}')}catch{return {}}}
function checkedKey(name,sha){return settings.url+'|'+session.user.id+'|'+name+'|'+sha}
async function hash(blob){const bytes=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('')}
async function download(name){const r=await request('object/authenticated/'+BUCKET+'/'+encodedPath(name));return await r.blob()}
async function uploadAll(){
 if(busy||syncing||state.busy||state.saving){display('正在执行其他任务，稍后再试');return}busy=true;state.busy=true;
 try{
  if(!navigator.onLine)throw Error('当前没有网络，无法上传');
  await getSession();await loadQueue();
  if(!state.queue.length)throw Error('Mac 页面尚未导入照片。请先点击「导入照片」');
  const oversized=state.queue.find(r=>r.bytes>50*1024*1024);if(oversized)throw Error(`${oversized.name} 超过 Supabase Free 单文件 50MB 上限；请升级云存储套餐或另选方案`);
  const total=state.queue.reduce((a,r)=>a+(r.bytes||0),0);if(total>900*1024*1024&&!confirm(`当前本机照片总量约 ${(total/1024/1024).toFixed(0)} MB，可能超过 Supabase Free 的1GB存储空间。仍要尝试上传吗？`))return;
  display('正在检查云端照片清单…');const cloud=new Set(await listCloud());let uploaded=0,skipped=0;
  const verified=readVerified();
  const jobs=[...state.queue.filter(r=>!cloud.has(r.name)),...state.queue.filter(r=>cloud.has(r.name))];
  for(let i=0;i<jobs.length;i++){
   const rec=jobs[i];
   if(document.visibilityState==='hidden')throw Error('网页进入后台，传输已在当前文件后暂停；再次点击可续传');
   display(`上传检查 ${i+1}/${jobs.length}：${rec.name}（新增${uploaded}张）`);
   const key=checkedKey(rec.name,rec.sha256);
   if(cloud.has(rec.name)&&verified[key]){skipped++;continue;}
   if(cloud.has(rec.name)){
    // Check an unknown existing remote file ONCE; remember verified hash thereafter.
    const remote=await download(rec.name);
    if(await hash(remote)!==rec.sha256)throw Error(`云端同名文件内容不一致：${rec.name}。已停止且绝不覆盖`);
    verified[key]=true;localStorage.setItem(VERIFIED_KEY,JSON.stringify(verified));
    skipped++;continue;
   }
   const local=await dbGet('photos',rec.name);if(!local?.blob)throw Error('本地找不到 '+rec.name);
   const path='object/'+BUCKET+'/'+encodedPath(rec.name);
   try{await request(path,{method:'POST',headers:{'Content-Type':local.blob.type||'application/octet-stream','x-upsert':'false','cache-control':'max-age=0'},body:local.blob})}
   catch(e){
    // If a second client uploaded simultaneously, compare bytes rather than overwriting.
    if(/exist|duplicate|409/i.test(e.message)){
     const remote=await download(rec.name);if(await hash(remote)===rec.sha256){skipped++;continue}
    }
    throw e;
   }
   uploaded++;verified[key]=true;localStorage.setItem(VERIFIED_KEY,JSON.stringify(verified));
  }
  display(`✓ 上传完成：新增 ${uploaded} 张，云端已存在 ${skipped} 张`);
  alert(`Mac 已完成云照片上传：\n新增 ${uploaded} 张，云端已存在 ${skipped} 张。\n\n现在打开 iPad，点击「同步云端照片」下载到本地。`);
 }catch(e){display('✕ '+e.message);alert('云端上传暂停：'+e.message+'\n\n已经上传成功的文件会保留。重新点击「Mac上传云端」可以安全续传。')}
 finally{busy=false;state.busy=false}
}
async function syncFromCloud(silent=false){
 if(syncing||busy||state.busy||state.saving||state.active||state.dirty){if(!silent)alert('请先结束当前画笔并等待保存完成，再同步照片');return;}
 if(!settings||!session){if(!silent)alert('请先打开「云照片库」并登录账号');return;}
 if(!navigator.onLine){if(!silent)alert('当前设备离线；请连接互联网再同步照片');return;}
 syncing=true;state.busy=true;
 try{
  await getSession();display('正在检查云端新照片…');
  await loadQueue();
  const remote=await listCloud();let done=0,skip=0;const verified=readVerified();
  // Download missing photos FIRST; one-time SHA verification of local duplicates follows.
  const ordered=[...remote.filter(name=>!localRecord(name)),...remote.filter(name=>!!localRecord(name))];
  for(let i=0;i<ordered.length;i++){
   if(document.visibilityState==='hidden')throw Error('页面进入后台，暂停下载；已成功保存的照片保留，下次点击可以续传');
   const name=ordered[i];const local=localRecord(name);
   if(local){
    const k=checkedKey(name,local.sha256);
    if(!verified[k]){
      display(`正在校验同名照片 ${i+1}/${ordered.length}：${name}`);
      const remoteBlob=await download(name);
      if(await hash(remoteBlob)!==local.sha256)throw Error(`本机 ${name} 与云端同名照片内容不同；已停止，绝不覆盖旧原图或标注。请先核对名称。`);
      verified[k]=true;localStorage.setItem(VERIFIED_KEY,JSON.stringify(verified));
    }
    skip++;continue;
   }
   display(`正在下载 ${i+1}/${ordered.length}：${name}`);
   const data=await download(name);
   // Original name is preserved; importOne hashes, validates image size and persists atomically.
   const typ=/\.png$/i.test(name)?'image/png':/\.webp$/i.test(name)?'image/webp':'image/jpeg';
   const res=await importOne(new File([data],name,{type:typ}));
   if(res==='ok')done++;else if(res==='dup')skip++;
  }
  await loadQueue();if(!state.name&&state.queue.length)await go(state.queue[0].name);
  display(`✓ 同步完成：新增 ${done} 张，本地共 ${state.queue.length} 张`);
  if(done)note(`已从云端下载 ${done} 张照片，已保存至本机，可断网绘制`,8500);
  else if(!silent)note('云端暂无新照片，本地原有照片和标注未改变');
  await storageWarning();
 }catch(e){display('✕ '+e.message);if(!silent)alert('照片同步失败：'+e.message+'\n本地照片和标注没有被删除。')}
 finally{syncing=false;state.busy=false}
}
function renderLogin(){
 $('cloudLogin').textContent=session?'退出账号':'登录云照片库';
 $('cloudAccount').textContent=session?`已登录：${session.user.email||session.user.id}`:'未登录';
 $('cloudPassword').value='';
}
function configureFromUI(){const next=validateSettings({url:$('cloudUrl').value,key:$('cloudKey').value});if(settings&&(settings.url!==next.url||settings.key!==next.key)){session=null;localStorage.removeItem(SESSION_KEY);renderLogin()}settings=next;localStorage.setItem(SETTINGS_KEY,JSON.stringify(settings));display('✓ 云端连接参数已保存到此设备');return settings}
async function login(){try{
 if(session){if(!confirm('退出云照片库？已下载照片和标注不会被删除。'))return;session=null;localStorage.removeItem(SESSION_KEY);renderLogin();display('已退出云端账户，本地照片仍在');return}
 configureFromUI();const email=$('cloudEmail').value.trim(),password=$('cloudPassword').value;
 if(!email||!password)throw Error('请输入已在 Supabase 创建的邮箱与密码');
 await authToken('password',{email,password});display('✓ 登录成功。请点击「同步云端照片」开始下载');$('cloudModal').style.display='none';
 }catch(e){display('✕ 登录失败：'+e.message);alert('云照片库登录失败：'+e.message)}}
function init(){
 settings=readStored();try{session=JSON.parse(localStorage.getItem(SESSION_KEY)||'null')}catch{session=null}
 if(settings){$('cloudUrl').value=settings.url;$('cloudKey').value=settings.key}
 renderLogin();
 $('cloudOpen').onclick=()=>{$('cloudModal').style.display='flex';};
 $('cloudModal').querySelector('h2').textContent='☁ 云照片库 · 稳定版 V2.0';
 $('cloudClose').onclick=()=>{$('cloudModal').style.display='none';};
 $('cloudSaveSettings').onclick=()=>{try{configureFromUI();note('云端配置已保存；请输入邮箱密码登录')}catch(e){alert(e.message)}};
 $('cloudLogin').onclick=login;
 // A distinct control makes diagnosis available without making any login attempt.
 const holder=$('cloudSaveSettings').parentElement;
 const button=document.createElement('button');button.id='cloudDiagnose';button.type='button';button.textContent='诊断连接（无须密码）';
 const report=document.createElement('pre');report.id='cloudDiagnosisResult';
 report.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;color:#b9dcff;font-size:12px;margin:8px 0;max-height:200px;overflow:auto';
 holder.appendChild(button);holder.parentElement.insertBefore(report,holder.nextSibling);
 button.onclick=()=>diagnoseConnection();

 $('cloudUpload').onclick=uploadAll;
 $('cloudSync').onclick=()=>syncFromCloud(false);
 // Stable V2: NO background interval, online handler, visibility handler or auto-download.
 // User-triggered sync keeps Safari memory free during Apple Pencil drawing.
 if(!settings)display('可配置云照片库：Mac 上传后 iPad 自动下载');
 else if(session)display('已登录，需点击「同步云端照片」手动同步（绘制时不后台下载）');
 else display('已配置云端，请点击云照片库登录');
}
window.CaihuaCloud={init,uploadAll,syncFromCloud};
})();
