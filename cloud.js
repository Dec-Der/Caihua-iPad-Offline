/* Caihua Cloud Photo Sync v1.1 — ONLY images synchronize; annotations stay in device IndexedDB.
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
async function authToken(grant,body){const r=await fetch(`${settings.url}/auth/v1/token?grant_type=${grant}`,{method:'POST',headers:jsonHeaders(),body:JSON.stringify(body),cache:'no-store'});const obj=await r.json().catch(()=>({}));if(!r.ok)throw errorFromPayload(obj,r.status);if(!obj.access_token||!obj.refresh_token||!obj.user?.id)throw Error('无法取得完整认证信息，请重新登录');session={access_token:obj.access_token,refresh_token:obj.refresh_token,user:obj.user,expires_at:Date.now()+(obj.expires_in||3600)*1000};localStorage.setItem(SESSION_KEY,JSON.stringify(session));renderLogin();return session}
async function getSession(){if(!settings)throw Error('请先配置云照片库');if(!session)throw Error('请先登录云照片库');if(Date.now()>session.expires_at-90_000){try{await authToken('refresh_token',{refresh_token:session.refresh_token})}catch(err){session=null;localStorage.removeItem(SESSION_KEY);renderLogin();throw Error('登录已过期，请重新登录：'+err.message)}}return session}
async function request(path,options={}){
 const ss=await getSession();
 const h={'apikey':settings.key,'Authorization':`Bearer ${ss.access_token}`,...options.headers};
 const r=await fetch(`${settings.url}/storage/v1/${path}`,{...options,headers:h,cache:'no-store'});
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
 if(busy||state.busy||state.saving){display('正在执行其他任务，稍后再试');return}busy=true;
 try{
  if(!navigator.onLine)throw Error('当前没有网络，无法上传');
  await getSession();await loadQueue();
  if(!state.queue.length)throw Error('Mac 页面尚未导入照片。请先点击「导入照片」');
  const oversized=state.queue.find(r=>r.bytes>50*1024*1024);if(oversized)throw Error(`${oversized.name} 超过 Supabase Free 单文件 50MB 上限；请升级云存储套餐或另选方案`);
  const total=state.queue.reduce((a,r)=>a+(r.bytes||0),0);if(total>900*1024*1024&&!confirm(`当前本机照片总量约 ${(total/1024/1024).toFixed(0)} MB，可能超过 Supabase Free 的1GB存储空间。仍要尝试上传吗？`))return;
  display('正在检查云端照片…');const cloud=new Set(await listCloud());let uploaded=0,skipped=0;
  for(let i=0;i<state.queue.length;i++){
   const rec=state.queue[i];display(`正在上传 ${i+1}/${state.queue.length}：${rec.name}`);
   const local=await dbGet('photos',rec.name);if(!local?.blob)throw Error('本地找不到 '+rec.name);
   if(cloud.has(rec.name)){
    const remote=await download(rec.name);
    if(await hash(remote)!==rec.sha256)throw Error(`云端已存在同名但内容不同的照片 ${rec.name}，已停止；没有覆盖任何文件`);
    skipped++;continue;
   }
   const path='object/'+BUCKET+'/'+encodedPath(rec.name);
   try{await request(path,{method:'POST',headers:{'Content-Type':local.blob.type||'application/octet-stream','x-upsert':'false','cache-control':'max-age=0'},body:local.blob})}
   catch(e){
    // If a second client uploaded simultaneously, compare bytes rather than overwriting.
    if(/exist|duplicate|409/i.test(e.message)){
     const remote=await download(rec.name);if(await hash(remote)===rec.sha256){skipped++;continue}
    }
    throw e;
   }
   uploaded++;
  }
  display(`✓ 上传完成：新增 ${uploaded} 张，云端已存在 ${skipped} 张`);
  alert(`Mac 已完成云照片上传：\n新增 ${uploaded} 张，云端已存在 ${skipped} 张。\n\n现在打开 iPad，联网后会自动同步到本地。`);
 }catch(e){display('✕ '+e.message);alert('云端上传暂停：'+e.message+'\n\n已经上传成功的文件会保留。重新点击「Mac上传云端」可以安全续传。')}
 finally{busy=false}
}
async function syncFromCloud(silent=false){
 if(syncing||busy||state.busy||state.saving||state.active||state.dirty)return;
 if(!settings||!session||!navigator.onLine)return;
 syncing=true;
 try{
  await getSession();display('正在检查云端新照片…');
  await loadQueue();
  const remote=await listCloud();let done=0,skip=0;const verified=readVerified();
  for(let i=0;i<remote.length;i++){
   const name=remote[i];const local=localRecord(name);
   if(local){
    const k=checkedKey(name,local.sha256);
    if(!verified[k]){
      display(`正在校验同名照片 ${i+1}/${remote.length}：${name}`);
      const remoteBlob=await download(name);
      if(await hash(remoteBlob)!==local.sha256)throw Error(`本机 ${name} 与云端同名照片内容不同；已停止，绝不覆盖旧原图或标注。请先核对名称。`);
      verified[k]=true;localStorage.setItem(VERIFIED_KEY,JSON.stringify(verified));
    }
    skip++;continue;
   }
   display(`正在下载 ${i+1}/${remote.length}：${name}`);
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
 finally{syncing=false}
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
 await authToken('password',{email,password});display('✓ 登录成功，正在同步照片…');$('cloudModal').style.display='none';await syncFromCloud(true);
 }catch(e){display('✕ 登录失败：'+e.message);alert('云照片库登录失败：'+e.message)}}
function init(){
 settings=readStored();try{session=JSON.parse(localStorage.getItem(SESSION_KEY)||'null')}catch{session=null}
 if(settings){$('cloudUrl').value=settings.url;$('cloudKey').value=settings.key}
 renderLogin();
 $('cloudOpen').onclick=()=>{$('cloudModal').style.display='flex';};
 $('cloudClose').onclick=()=>{$('cloudModal').style.display='none';};
 $('cloudSaveSettings').onclick=()=>{try{configureFromUI();note('云端配置已保存；请输入邮箱密码登录')}catch(e){alert(e.message)}};
 $('cloudLogin').onclick=login;
 $('cloudUpload').onclick=uploadAll;
 $('cloudSync').onclick=()=>syncFromCloud(false);
 window.addEventListener('online',()=>syncFromCloud(true));
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')syncFromCloud(true)});
 timer=setInterval(()=>{if(document.visibilityState==='visible')syncFromCloud(true)},60000);
 if(settings&&session&&navigator.onLine)setTimeout(()=>syncFromCloud(true),1400);
 if(!settings)display('可配置云照片库：Mac 上传后 iPad 自动下载');
 else if(session)display('云端已登录，联网时自动下载新照片');
 else display('已配置云端，请点击云照片库登录');
}
window.CaihuaCloud={init,uploadAll,syncFromCloud};
})();
