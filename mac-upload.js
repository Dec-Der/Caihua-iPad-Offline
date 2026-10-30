/* Caihua V3.0 — Mac direct uploader. No IndexedDB, no image decoding,
   no JSZip, no photo copying. Original File objects transmitted unchanged. */
'use strict';
(()=>{
const $=id=>document.getElementById(id),api=window.CaihuaApi;
let selected=[],uploading=false,stop=false;
function status(t){$('status').textContent=t}
function log(t){$('log').textContent+=new Date().toLocaleTimeString()+'  '+t+'\n';$('log').scrollTop=$('log').scrollHeight}
function render(){const names=$('filesSummary');const size=selected.reduce((s,f)=>s+f.size,0);names.textContent=`已选择 ${selected.length} 张，原文件总量 ${(size/1024/1024).toFixed(1)} MB；不改变原尺寸或像素`;$('upload').disabled=uploading||!selected.length}
function logged(){const s=api.session();$('account').textContent=s?'已登录：'+(s.user.email||s.user.id):'未登录';$('login').textContent=s?'退出当前账号':'登录';}
function save(){api.configure($('url').value,$('key').value);logged();status('已保存连接信息')}
async function login(){try{if(api.session()){if(confirm('退出云端登录？'))api.logout();logged();return}save();await api.login($('email').value,$('password').value);$('password').value='';logged();status('登录成功');log('已登录私有云相册');}catch(e){status('登录失败：'+e.message);log('登录失败：'+e.message)}}
async function choose(list){if(uploading)return;const files=[...list].filter(f=>/\.(png|jpe?g|webp)$/i.test(f.name));const map=new Map();for(const f of files){const lower=f.name.toLowerCase();if(map.has(lower)){alert('选择中存在重名文件：'+f.name+'，请先整理文件名');return}map.set(lower,f)}selected=files.sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));render();log('已选择 '+files.length+' 张原文件');}
// Large files use the official Supabase TUS endpoint: 6 MB chunks, safe resume after interruption.
// The Mac page loads the pinned tus-js-client browser build; if a network blocks that
// library, the user can explicitly opt into the less robust standard upload.
async function uploadTus(file, progress) {
 if (!window.tus?.Upload) throw Error('分块续传库尚未载入，可能被网络或内容拦截器阻止');
 const setting=api.settings(),owner=api.owner(),token=(await api.auth()).access_token;
 const direct=setting.url.replace(/\.supabase\.co$/,'.storage.supabase.co');
 return new Promise((resolve,reject)=>{
   const up=new window.tus.Upload(file,{
     endpoint:direct+'/storage/v1/upload/resumable',
     retryDelays:[0,1500,3000,6000,12000],
     headers:{authorization:'Bearer '+token,apikey:setting.key,'x-upsert':'false'},
     uploadDataDuringCreation:true,
     removeFingerprintOnSuccess:true,
     metadata:{bucketName:api.BUCKET,objectName:owner+'/'+file.name,
       contentType:file.type||'application/octet-stream',cacheControl:'3600'},
     chunkSize:6*1024*1024,
     onProgress:(bytes,total)=>progress(bytes,total),
     onError:err=>reject(Error('分块上传失败：'+(err.originalResponse?.getBody?.()||err.message||String(err)))),
     onSuccess:()=>resolve()
   });
   up.findPreviousUploads().then(previous=>{
     if(previous.length)up.resumeFromPreviousUpload(previous[0]);
     up.start();
   }).catch(reject);
 });
}
async function uploadOne(file,progress){
 if(file.size>6*1024*1024){
   if(window.tus?.Upload)return uploadTus(file,progress);
   if(!confirm('分块续传组件没有加载成功（可能被网络拦截）。\n'+file.name+' 超过6MB；改用普通上传可能因断网而整张重传。是否继续？'))
     throw Error('已取消普通上传。可检查网络、暂时关闭内容拦截器后重试。');
 }
 return api.upload(file);
}
async function uploadAll(){if(uploading||!selected.length)return;uploading=true;stop=false;render();$('stop').disabled=false;
 let ok=0,skipped=0,failed=0;
 try{
  await api.auth();status('正在读取私有云照片清单…');const remote=new Map((await api.list()).map(x=>[x.name.toLowerCase(),x]));
  for(const file of selected){const r=remote.get(file.name.toLowerCase());if(r&&r.bytes&&r.bytes!==file.size)throw Error('云端存在同名但大小不同照片：'+file.name+'。已停止，不会覆盖');}
  const jobs=selected.filter(f=>!remote.has(f.name.toLowerCase()));skipped=selected.length-jobs.length;
  log('已存在 '+skipped+' 张；只传新增的 '+jobs.length+' 张（同名同大小按清单跳过；不能证明内容完全一致）');
  for(let i=0;i<jobs.length;i++){
    if(stop){log('用户暂停。已完成文件不会重传');break}
    const f=jobs[i];if(f.size>50*1024*1024)throw Error(f.name+' 超过当前预设50MB限制，请在Supabase查看项目与bucket的真实限额');
    status(`上传 ${i+1}/${jobs.length}：${f.name}`);
    try{
      await uploadOne(f,(done,total)=>status(`上传 ${i+1}/${jobs.length}：${f.name} · ${Math.round(100*done/total)}%`));
      ok++;log(`✓ ${f.name} ${(f.size/1024/1024).toFixed(1)} MB`);
    }catch(e){
      // A timed-out creation/commit can have succeeded; check before retrying.
      const current=(await api.list().catch(()=>[])).find(x=>x.name===f.name);
      if(current&&(!current.bytes||current.bytes===f.size)){skipped++;log('✓ '+f.name+' 已在云端（请复核文件）')}
      else{failed++;log('✕ '+f.name+' '+e.message);break}
    }
  }
  const pending=selected.length-ok-skipped-failed;
  const result=pending||failed?'本批尚未完成':'本批全部完成';
  status(`${result}：新上传 ${ok} 张｜已存在/核实 ${skipped} 张｜失败 ${failed} 张｜待处理 ${pending} 张。${pending||failed?'点击“开始上传”继续，已完成文件会自动跳过':'可选择下一批照片'}`);
  log(`${result}，新上传${ok}张，跳过${skipped}张，失败${failed}张，待处理${pending}张`);
 }catch(e){status('传输暂停：'+e.message);log('传输暂停：'+e.message)}
 finally{uploading=false;$('stop').disabled=true;render()}
}
async function remoteList(){try{await api.auth();status('读取云端照片…');const photos=await api.list();$('remoteList').textContent=photos.map(x=>x.name+'  '+(x.bytes?(x.bytes/1024/1024).toFixed(1)+'MB':'')).join('\n');$('remoteCount').textContent=`当前账号云端 ${photos.length} 张`;status('读取成功')}
 catch(e){status('读取失败：'+e.message)}}
function init(){const s=api.settings();if(s){$('url').value=s.url;$('key').value=s.key}logged();
 document.addEventListener('visibilitychange',()=>{if(uploading)log(document.visibilityState==='hidden'?'页面已转到后台，继续上传；请勿关闭页面或让 Mac 休眠':'页面已回到前台，继续当前上传任务')});
 $('save').onclick=()=>{try{save()}catch(e){status(e.message)}};$('login').onclick=login;
 $('photos').onchange=e=>{choose(e.target.files);e.target.value=''};
 $('upload').onclick=uploadAll;$('stop').onclick=()=>{stop=true;status('已请求暂停，等待当前文件结束')};$('list').onclick=remoteList;
 $('diagnose').onclick=async()=>{try{save();const r=await api.diagnosis();status('Supabase 可响应 HTTP '+r.status)}catch(e){status('诊断失败：'+e.message)}};
}
init();
})();
