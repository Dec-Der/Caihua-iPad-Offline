/* Caihua V3.1.1 -- remove only genuinely untouched LOCAL images. Never call the cloud API. */
'use strict';
(()=>{
  const get=id=>document.getElementById(id);
  let candidates=new Map(),running=false;
  const empty=(rec,doc)=>!!rec && (rec.status==null||rec.status==='pending') &&
    (!doc || ((doc.status==null||doc.status==='pending') && Array.isArray(doc.strokes) && doc.strokes.length===0));
  const fingerprint=(rec,doc)=>JSON.stringify([
    rec?.name,rec?.status??'pending',rec?.bytes??null,rec?.sha256??null,
    doc?.status??'pending',doc?.updated??null,doc?.strokes?.length??null
  ]);
  const idle=()=>!state.busy && !state.saving && !state.active && !state.dirty &&
    !state.latestBackup && !backupPlan && !running;
  const status=s=>{get('pendingCleanStatus').textContent=s;};
  const checked=()=>[...get('pendingCleanRows').querySelectorAll('input[type="checkbox"]:checked')]
    .map(x=>candidates.get(x.value)).filter(Boolean);
  function update(){
    const list=checked(),sum=list.reduce((n,x)=>n+(x.rec.bytes||0),0);
    get('pendingCleanDelete').disabled=running || !list.length || !get('pendingCleanConfirm').checked;
    get('pendingCleanDelete').textContent=`删除本机选中 ${list.length} 张`;
    get('pendingCleanSize').textContent=`已选 ${list.length} 张，原图约 ${(sum/1048576).toFixed(1)} MB`;
  }
  function rows(){
    const el=get('pendingCleanRows');el.replaceChildren();
    for(const c of candidates.values()){
      const label=document.createElement('label'),tick=document.createElement('input'),span=document.createElement('span');
      tick.type='checkbox';tick.value=c.rec.name;tick.onchange=update;
      span.textContent=c.rec.name+' · 待画 · '+((c.rec.bytes||0)/1048576).toFixed(1)+' MB';
      label.append(tick,span);el.append(label);
    }
    update();
  }
  async function open(){
    if(!idle()){alert('请先结束绘制、照片同步或 JSON 备份，等待保存完成后再清理');return;}
    running=true;
    candidates.clear();get('pendingCleanRows').replaceChildren();get('pendingCleanConfirm').checked=false;
    get('pendingCleanModal').style.display='flex';status('正在读取本机待画照片状态…');
    try{
      const all=await dbAll('records');let count=0;
      for(const rec of all){
        if(rec.status!=null && rec.status!=='pending')continue;
        const doc=await dbGet('docs',rec.name);
        if(!empty(rec,doc))continue;
        const photo=await dbGet('photos',rec.name);
        if(!photo?.blob)continue;
        candidates.set(rec.name,{rec,fingerprint:fingerprint(rec,doc)});count++;
      }
      rows();status(`找到 ${count} 张本机待画且完全没有笔画的照片。请手动勾选；不会触碰云端、已标注或已确认无裂隙的照片。`);
    }catch(e){candidates.clear();rows();status('读取失败：'+e.message+'。没有删除任何照片。');}
    finally{running=false;update()}
  }
  function deleteAtomic(c){
    return dbTransaction(['records','photos','docs'],'readwrite',tx=>{
      const recReq=tx.objectStore('records').get(c.rec.name);
      const docReq=tx.objectStore('docs').get(c.rec.name);
      let reads=0;
      const verify=()=>{
        if(++reads!==2)return;
        if(!empty(recReq.result,docReq.result) || fingerprint(recReq.result,docReq.result)!==c.fingerprint){
          tx.abort();return;
        }
        // One transaction: remove local photo bytes, queue entry and empty draft together.
        tx.objectStore('photos').delete(c.rec.name);
        tx.objectStore('docs').delete(c.rec.name);
        tx.objectStore('records').delete(c.rec.name);
      };
      recReq.onsuccess=verify;docReq.onsuccess=verify;
    });
  }
  function releaseCurrent(){
    if(state.url)URL.revokeObjectURL(state.url);
    state.url=null;state.name=null;state.doc=null;state.image=null;state.active=null;
    state.undo=[];state.redo=[];state.dirty=false;
    get('currentName').textContent='请选择照片';draw();
  }
  async function remove(){
    if(!idle())return;
    const list=checked();
    if(!list.length || !get('pendingCleanConfirm').checked)return;
    const preview=list.slice(0,12).map(x=>x.rec.name).join('\n');
    const extras=list.length>12?`\n……以及另外 ${list.length-12} 张`:'';
    if(!confirm(`只删除这台 iPad 浏览器本地的 ${list.length} 张待画原图？\n\n${preview}${extras}\n\n不删除 Supabase 云端原图，不删除已经有笔画或已确认无裂隙的照片。\n以后点击“同步云端照片”会重新下载云端仍存在的照片。`))return;
    running=true;state.busy=true;update();
    get('pendingCleanClose').disabled=true;get('pendingCleanSelect').disabled=true;
    let done=0,failed='';
    try{
      for(const c of list){
        status(`本地清理 ${done+1}/${list.length}：${c.rec.name}`);
        if(state.name===c.rec.name)releaseCurrent();
        await deleteAtomic(c);
        candidates.delete(c.rec.name);done++;
      }
    }catch(e){failed=e.message;}
    finally{
      state.busy=false;running=false;
      get('pendingCleanClose').disabled=false;get('pendingCleanSelect').disabled=false;
      try{await loadQueue();if(!state.name && state.queue.length)await go(state.queue[0].name)}
      catch(e){failed+=(failed?'；':'')+'刷新列表失败：'+e.message;}
      rows();get('pendingCleanConfirm').checked=false;update();
      status(`本机成功清理 ${done} 张。`+(failed?'已停止：'+failed+'。其余本地照片未继续删除。':' 云端原图及已有标注未修改。'));
      setStatus(`本机已清理 ${done} 张待画照片`);
    }
  }
  get('pendingCleanOpen').onclick=open;
  get('pendingCleanClose').onclick=()=>{if(!running)get('pendingCleanModal').style.display='none';};
  get('pendingCleanSelect').onclick=()=>{if(running)return;const boxes=[...get('pendingCleanRows').querySelectorAll('input[type="checkbox"]')];const all=boxes.every(x=>x.checked);for(const b of boxes)b.checked=!all;update();};
  get('pendingCleanConfirm').onchange=update;
  get('pendingCleanDelete').onclick=()=>remove().catch(e=>status('未完成清理：'+e.message));
})();
