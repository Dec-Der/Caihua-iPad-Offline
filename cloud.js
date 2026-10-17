/* Caihua V3.0 iPad downloader. Manual only, no background tasks, no Mac upload. */
'use strict';
(()=>{
const $=id=>document.getElementById(id),api=window.CaihuaApi;let busy=false;
const display=s=>$('cloudStatus').textContent=s;
function logged(){const user=api.session()?.user;$('cloudLogin').textContent=user?'退出账号':'登录云照片库';$('cloudAccount').textContent=user?'已登录：'+(user.email||user.id):'未登录';$('cloudPassword').value=''}
function save(){api.configure($('cloudUrl').value,$('cloudKey').value);display('云端配置已保存')}
async function login(){try{if(api.session()){if(confirm('退出账号？iPad本地照片及标注不会被删除。')){api.logout();logged()}return;}const email=$('cloudEmail').value,password=$('cloudPassword').value;save();await api.login(email,password);logged();$('cloudModal').style.display='none';display('✓ 云照片库已登录')}catch(e){display('登录失败：'+e.message);alert('云照片库登录失败：'+e.message)}}
async function sync(){
 if(busy||state.busy||state.saving||state.active||state.dirty){alert('正在画笔保存或执行其他任务，请结束并等待完成');return}
 if(!navigator.onLine){alert('iPad 目前离线，请联网后再同步新照片');return}
 busy=true;state.busy=true;
 try{
  await api.auth();await loadQueue();display('正在读取云端照片清单…');const remote=await api.list();const names=new Map(state.queue.map(x=>[x.name.toLowerCase(),x]));
  let added=0,skip=0;const pending=remote.filter(x=>!names.has(x.name.toLowerCase()));
  const errors=[];
  for(const r of remote){const local=names.get(r.name.toLowerCase());if(local){if(local.bytes&&r.bytes&&local.bytes!==r.bytes)errors.push(r.name+' 本地/云端文件大小不一致');else skip++}}
  if(errors.length)throw Error(errors.slice(0,3).join('；')+'，请检查，不会覆盖已有标注');
  for(let i=0;i<pending.length;i++){
    if(document.visibilityState==='hidden')throw Error('iPad 页面进入后台，本轮暂停；已保存的照片保留，重新点击可继续');
    const r=pending[i];display(`下载并保存 ${i+1}/${pending.length}：${r.name}`);
    const blob=await api.download(r.name);
    const outcome=await importCloudBlob(blob,r.name,r.bytes);if(outcome==='ok')added++;else skip++;
    if((i+1)%5===0)await new Promise(res=>setTimeout(res,0));
  }
  await loadQueue();
  display(`✓ 云端${remote.length}张｜新增${added}张｜iPad本地${state.queue.length}张`);
  note('下载完成。离线可继续标注。已存在照片未覆盖。',8500);await storageWarning();
 }catch(e){display('同步暂停：'+e.message);alert('云端同步暂停：'+e.message+'\n已成功保存的照片和原有JSON不受影响，联网后可以重试。')}
 finally{busy=false;state.busy=false; if(!state.name && state.queue.length) {try{await go(state.queue[0].name)}catch(e){display('已下载，但打开照片失败：'+e.message)}}}
}
function init(){const s=api.settings();if(s){$('cloudUrl').value=s.url;$('cloudKey').value=s.key}logged();
 $('cloudOpen').onclick=()=>$('cloudModal').style.display='flex';$('cloudClose').onclick=()=>$('cloudModal').style.display='none';
 $('cloudSaveSettings').onclick=()=>{try{save()}catch(e){alert(e.message)}};
 $('cloudLogin').onclick=login;$('cloudSync').onclick=sync;
 // Separate troubleshooting from credential errors.
 const parent=$('cloudSaveSettings').parentElement;const b=document.createElement('button');b.textContent='诊断连接（不发送密码）';parent.append(b);b.onclick=async()=>{try{save();const d=await api.diagnosis();alert('iPad 到 Supabase 可收到 HTTP '+d.status+'。如登录仍失败，请查看 Supabase Auth 日志。')}catch(e){alert('诊断失败：'+e.message)}};
 display(api.session()?'登录会话已保留。点击同步获取新照片':'登录一次后点击同步云端照片');
}
window.CaihuaCloud={init,sync};
})();
