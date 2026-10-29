'use strict';
(()=>{
 const api=window.CaihuaApi,rules=window.CaihuaCleanupRules;
 let jobs=new Map(),account=null,running=false;
 const message=t=>$('cleanupStatus').textContent=t;
 const unchanged=(rec,doc,job)=>rules.stable({rec,doc})===job.snapshot;
 function idle(){return !state.busy&&!state.saving&&!state.active&&!state.dirty&&!state.latestBackup&&!backupPlan}
 function reset(){jobs.clear();$('cleanupRows').replaceChildren();$('cleanupSaved').checked=false;$('cleanupOriginals').checked=false;update()}
 function update(){
  const n=[...$('cleanupRows').querySelectorAll('input:checked')].length;
  $('cleanupDelete').disabled=running||!n||!$('cleanupSaved').checked||!$('cleanupOriginals').checked;
  $('cleanupDelete').textContent=`删除选中 ${n} 张（本机＋云端）`;
 }
 function drawRows(){
  $('cleanupRows').replaceChildren();
  for(const job of jobs.values()){
   const label=document.createElement('label'),box=document.createElement('input'),name=document.createElement('span');
   box.type='checkbox';box.value=job.rec.name;box.onchange=update;
   name.textContent=job.rec.name+' · '+(job.rec.status==='negative'?'无裂隙':'已标注');
   label.append(box,name);$('cleanupRows').append(label);
  }
  update();
 }
 async function open(){
  if(!idle()){alert('请先结束绘制、同步或备份，等待保存成功后再清理');return}
  reset();$('cleanupFiles').value='';$('cleanupModal').style.display='flex';
  message('请选择“文件”App 中已保存的 JSON 备份 ZIP。只有与当前标注完全一致的已完成图片才会列出。');
 }
 async function checkBackups(files){
  if(running||!idle())return;
  reset();if(!files.length)return;
  state.busy=true;running=true;
  try{
   await api.auth();account={url:api.settings().url,owner:api.owner()};
   $('cleanupAccount').textContent='将清理当前云端账号：'+(api.session().user.email||account.owner);
   await loadQueue();let checked=0;
   for(const file of files){
    if(file.size>256*1024*1024)throw Error(file.name+' 大于256MB，请在 Mac 核验后分批处理');
    message('正在核验 '+file.name+'…');
    const zip=await JSZip.loadAsync(file,{checkCRC32:true}),manifestFile=zip.file('offline_manifest.json');
    if(!manifestFile)throw Error(file.name+' 缺少备份清单');
    const manifest=JSON.parse(await manifestFile.async('string')),covered=rules.coveredImages(manifest);
    const stemCounts=new Map();
    for(const e of manifest.images){const s=e.name.replace(/\.[^.]+$/,'');stemCounts.set(s,(stemCounts.get(s)||0)+1)}
    for(const entry of covered){
     checked++;
     const rec=await dbGet('records',entry.name),doc=await dbGet('docs',entry.name);
     if(!rec||!doc)continue;
     let json=null;
     if(doc.status==='annotated'){
      const stem=rec.name.replace(/\.[^.]+$/,'');if(stemCounts.get(stem)!==1)continue;
      const item=zip.file('annotations/'+stem+'.json');if(!item)continue;
      json=JSON.parse(await item.async('string'));
     }
     if(rules.matches(rec,doc,entry,json,backupDoc(rec,doc)))
      jobs.set(rec.name,{rec,doc,snapshot:rules.stable({rec,doc})});
    }
   }
   drawRows();message(`已核验 ${files.length} 个备份包；${jobs.size} 张与本机一致，可以勾选。待画、已修改或缺少备份的图片不会列入。`);
  }catch(e){reset();message('核验未完成：'+e.message)}
  finally{state.busy=false;running=false;update()}
 }
 function assertAccount(){
  if(!account||api.settings()?.url!==account.url||api.owner()!==account.owner)
   throw Error('账号或云端项目发生变化，请关闭窗口后重新核验备份');
 }
 async function assertCurrent(job){
  assertAccount();
  const rec=await dbGet('records',job.rec.name),doc=await dbGet('docs',job.rec.name);
  if(!unchanged(rec,doc,job))throw Error(job.rec.name+' 已被修改，请重新保存备份后再清理');
 }
 async function digest(blob){
  if(!crypto.subtle)throw Error('无法校验原图，请使用 HTTPS');
  const bytes=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
 }
 async function checkCloud(job){
  await api.auth();assertAccount();
  if(job.rec.cloud&&(job.rec.cloud.url!==account.url||job.rec.cloud.owner!==account.owner))
   throw Error(job.rec.name+' 来自另一个云端账号或项目，已停止');
  const remote=(await api.list()).find(x=>x.name===job.rec.name);assertAccount();
  job.remote=!!remote;if(!remote)return;
  const photo=await dbGet('photos',job.rec.name);
  if(!photo?.blob)throw Error(job.rec.name+' 缺少本机原图，无法核对');
  if(remote.bytes&&remote.bytes!==photo.blob.size)throw Error(job.rec.name+' 云端与本机原图大小不同，禁止删除');
  message('核对云端原图内容：'+job.rec.name+'（会产生下载流量）');
  const localHash=await digest(photo.blob),cloudBlob=await api.download(job.rec.name);assertAccount();
  if(cloudBlob.size!==photo.blob.size||await digest(cloudBlob)!==localHash)
   throw Error(job.rec.name+' 云端同名图片内容不同，禁止删除');
 }
 function removeLocal(job){
  return dbTransaction(['records','photos','docs'],'readwrite',tx=>{
   const a=tx.objectStore('records').get(job.rec.name),b=tx.objectStore('docs').get(job.rec.name);
   let ready=0;
   const done=()=>{if(++ready!==2)return;
    if(!unchanged(a.result,b.result,job)){tx.abort();return}
    for(const store of ['records','photos','docs'])tx.objectStore(store).delete(job.rec.name);
   };
   a.onsuccess=done;b.onsuccess=done;
  });
 }
 async function removeSelected(){
  if(running||!idle())return;
  const chosen=[...$('cleanupRows').querySelectorAll('input:checked')].map(x=>jobs.get(x.value));
  if(!chosen.length||!$('cleanupSaved').checked||!$('cleanupOriginals').checked)return;
  assertAccount();
  const names=chosen.map(x=>x.rec.name).join('\n');
  if(!confirm(`永久删除以下 ${chosen.length} 张的 iPad 照片、标注和当前账号对应云端原图？\n\n${names}\n\n已保存到“文件”App 的 ZIP 和 Mac 原图不会被删除。此操作无法撤销。`))return;
  state.busy=true;running=true;update();let deleted=0,failure='';
  $('cleanupFiles').disabled=true;$('cleanupClose').disabled=true;$('cleanupSelectAll').disabled=true;
  try{
   if(!navigator.onLine)throw Error('当前离线，请联网后重试');
   for(const job of chosen){
    message(`清理 ${deleted+1}/${chosen.length}：${job.rec.name}`);
    await rules.deleteOne(job,{
     assertCurrent,checkCloud,
     removeCloud:async j=>{assertAccount();await api.removePhoto(j.rec.name,account);assertAccount()},
     assertCloudAbsent:async j=>{
      await api.auth();assertAccount();const remaining=await api.list();assertAccount();
      if(remaining.some(x=>x.name===j.rec.name))throw Error(j.rec.name+' 云端仍存在，可能缺少 DELETE 权限；本机数据已保留');
     },removeLocal
    });
    jobs.delete(job.rec.name);deleted++;
    if(state.name===job.rec.name){
     state.name=null;state.doc=null;state.image=null;state.undo=[];state.redo=[];
     if(state.url)URL.revokeObjectURL(state.url);state.url=null;
     $('currentName').textContent='请选择照片';$('info').textContent='手指移动画面 · Pencil 绘制裂隙';draw();
    }
   }
  }catch(e){failure=e.message}
  finally{
   state.busy=false;running=false;
   $('cleanupFiles').disabled=false;$('cleanupClose').disabled=false;$('cleanupSelectAll').disabled=false;
   try{await loadQueue();if(!state.name&&state.queue.length)await go(state.queue[0].name)}catch(e){failure+=(failure?'；':'')+e.message}
   drawRows();$('cleanupSaved').checked=false;$('cleanupOriginals').checked=false;update();
   const result=`已清理 ${deleted} 张。`+(failure?'已停止：'+failure+'。未清理成功的本机数据保留；若云端已删除，可在核对后重试完成本机清理。':'已保存的 ZIP 与 Mac 原图保留。');
   message(result);setStatus(result);
  }
 }
 $('cleanupOpen').onclick=open;
 $('cleanupFiles').onchange=e=>checkBackups([...e.target.files]);
 $('cleanupClose').onclick=()=>{if(!running)$('cleanupModal').style.display='none'};
 $('cleanupSelectAll').onclick=()=>{if(!running){for(const box of $('cleanupRows').querySelectorAll('input'))box.checked=true;update()}};
 $('cleanupSaved').onchange=update;$('cleanupOriginals').onchange=update;
 $('cleanupDelete').onclick=()=>removeSelected().catch(e=>message(e.message));
})();
