/* Caihua V3.0 shared Supabase client. Only publishable/anon keys in client.
   No service_role; no credentials in repository; data access governed by RLS. */
'use strict';
(()=>{
const BUCKET='caihua-photos';
const SETTINGS_KEY='caihua_cloud_settings_v1', SESSION_KEY='caihua_cloud_session_v1';
let settings=null,session=null,refreshPromise=null;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function restore(){
 try{settings=JSON.parse(localStorage.getItem(SETTINGS_KEY)||'null')}catch{settings=null}
 try{session=JSON.parse(localStorage.getItem(SESSION_KEY)||'null')}catch{session=null}
 if(!session?.user?.id||!session?.refresh_token)session=null;
 return {settings,session};
}
function configure(url,key){
 const u=String(url||'').trim().replace(/\/+$/,'');const k=String(key||'').trim();
 if(!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(u))throw Error('Project URL 必须是 https://项目ID.supabase.co');
 if(!k||k.startsWith('sb_secret_'))throw Error('请使用 publishable/anon 公钥，不能使用 secret 密钥');
 if(k.includes('.')){try{const payload=JSON.parse(atob(k.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));if(payload.role!=='anon')throw Error('必须使用 anon 密钥')}catch(e){if(/必须使用/.test(e.message))throw e}}
 if(settings&&(settings.url!==u||settings.key!==k))logout();
 settings={url:u,key:k};localStorage.setItem(SETTINGS_KEY,JSON.stringify(settings));return settings;
}
function logout(){session=null;localStorage.removeItem(SESSION_KEY)}
function netError(e){return e?.name==='AbortError'||/load failed|failed to fetch|network|fetch failed|timeout|中止|超时/i.test(String(e?.message||e))||e instanceof TypeError}
async function http(url,opt={},timeout=60000,retries=2){
 for(let i=0;i<=retries;i++){
  const controller=new AbortController(),tid=setTimeout(()=>controller.abort(),timeout);
  try{const result=await fetch(url,{...opt,signal:controller.signal,cache:'no-store'});return result}
  catch(e){if(i===retries||!netError(e))throw Error(`连接未完成：${e.message||e.name}。请检查网络及 Supabase 用量状态`);await sleep(450*(i+1))}
  finally{clearTimeout(tid)}
 }
}
async function parseResponse(r){let obj=null;try{obj=await r.json()}catch{}if(!r.ok)throw Error((obj?.msg||obj?.message||obj?.error_description||obj?.error||`HTTP ${r.status}`)+` (HTTP ${r.status})`);return obj}
function saveSession(obj){if(!obj?.access_token||!obj?.refresh_token||!obj?.user?.id)throw Error('认证响应缺少会话字段');session={access_token:obj.access_token,refresh_token:obj.refresh_token,user:obj.user,expires_at:Date.now()+Math.max(60,obj.expires_in||3600)*1000};localStorage.setItem(SESSION_KEY,JSON.stringify(session));return session}
async function token(grant,body){if(!settings)throw Error('请先保存云端配置');const r=await http(`${settings.url}/auth/v1/token?grant_type=${grant}`,{method:'POST',headers:{'apikey':settings.key,'Content-Type':'application/json'},body:JSON.stringify(body)},20000,2);return saveSession(await parseResponse(r))}
async function login(email,password){return token('password',{email:String(email||'').trim(),password:String(password||'')})}
async function auth(){if(!settings)throw Error('未配置 Supabase');if(!session)throw Error('未登录，请在云照片库输入邮箱密码');if(Date.now()<session.expires_at-90_000)return session;
 if(!refreshPromise)refreshPromise=token('refresh_token',{refresh_token:session.refresh_token}).catch(e=>{if(!netError(e)&&/invalid|expired|refresh|401|400/i.test(e.message))logout();throw e}).finally(()=>{refreshPromise=null});
 return refreshPromise;
}
function owner(){return session?.user?.id||''}
function path(name){if(!/^[^/\\]+\.(png|jpg|jpeg|webp)$/i.test(name))throw Error('文件名不允许路径字符或非图像扩展名：'+name);return encodeURIComponent(owner())+'/'+encodeURIComponent(name)}
async function storage(endpoint,opt={},timeout=65000,retries=2){const s=await auth();const r=await http(`${settings.url}/storage/v1/${endpoint}`,{...opt,headers:{'apikey':settings.key,'Authorization':'Bearer '+s.access_token,...opt.headers}},timeout,retries);return r}
async function list(){await auth();const all=[];let offset=0;for(let page=0;page<1000;page++){
 const r=await storage('object/list/'+BUCKET,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefix:owner()+'/',limit:100,offset,sortBy:{column:'name',order:'asc'}})},30000,2);
 const items=await parseResponse(r);if(!Array.isArray(items))throw Error('存储列表格式错误');for(const it of items)if(it.id!=null&&/\.(png|jpe?g|webp)$/i.test(it.name))all.push({name:it.name,bytes:Number(it.metadata?.size)||0});
 if(items.length<100)break;offset+=items.length;
 }
 return all;
}
async function download(name){const r=await storage('object/authenticated/'+BUCKET+'/'+path(name),{method:'GET'},120000,2);if(!r.ok)await parseResponse(r);return r.blob()}
async function upload(file){
 // Do not automatically repeat uncertain POSTs; recheck cloud list on next attempt.
 const r=await storage('object/'+BUCKET+'/'+path(file.name),{method:'POST',headers:{'Content-Type':file.type||'application/octet-stream','x-upsert':'false'},body:file},180000,0);
 return parseResponse(r);
}
// Deletion is explicit, scoped to the account/project reviewed by the user,
// and never retried automatically after an uncertain network result.
async function removePhoto(name,expected){
 const s=await auth();
 if(!expected||settings.url!==expected.url||s.user.id!==expected.owner)
   throw Error('云端账号或项目已改变，请重新打开清理窗口');
 path(name); // Validate the basename before constructing the raw Storage path.
 const r=await http(`${settings.url}/storage/v1/object/${BUCKET}`,{
   method:'DELETE',headers:{apikey:settings.key,Authorization:'Bearer '+s.access_token,'Content-Type':'application/json'},
   body:JSON.stringify({prefixes:[s.user.id+'/'+name]})
 },60000,0);
 return parseResponse(r);
}
async function diagnosis(){if(!settings)throw Error('先保存 Project URL 和公钥');const r=await http(settings.url+'/auth/v1/health',{headers:{apikey:settings.key}},15000,0);return {status:r.status,connected:true};}
window.CaihuaApi={restore,configure,logout,login,auth,owner,list,download,upload,removePhoto,diagnosis,session:()=>session,settings:()=>settings,BUCKET};
restore();
})();
