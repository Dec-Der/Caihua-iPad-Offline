/* Caihua iPad annotator V3.1.2 pen-tip fix, original V1.2 Smooth: private photos + stroke JSON live in iPad IndexedDB.
   Legacy strokes retain upstream ribbon geometry; new strokes use versioned round-dabs-v2.
   1–45 image px: radius = 0.5 + 22*filtered_pressure. */
'use strict';
const $ = id => document.getElementById(id);
const WIDTH_BASE=.5, WIDTH_SCALE=22, DB_NAME='caihua-ipad-offline-v1';
const state={db:null,queue:[],name:null,doc:null,image:null,url:null,zoom:1,offsetX:0,offsetY:0,tool:'brush',active:null,touches:new Map(),pinch:null,undo:[],redo:[],busy:false,saving:false,dirty:false,latestBackup:null};
let noticeTimer;
function note(str,ms=3000){const el=$('messages');el.textContent=str;el.style.display='block';clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>el.style.display='none',ms)}
function setStatus(str){$('status').textContent=str}
// Stable V2: reopen a stale IndexedDB connection on Safari, without clearing data.
// A write is never repeated automatically after its transaction has begun: commits can be ambiguous.
let openingDB=null;
function idb(){
  if(state.db)return Promise.resolve(state.db);
  if(openingDB)return openingDB;
  openingDB=new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,1);
    req.onupgradeneeded=()=>{const db=req.result;for(const s of ['records','photos','docs'])if(!db.objectStoreNames.contains(s))db.createObjectStore(s,{keyPath:'name'})};
    req.onblocked=()=>setStatus('数据库正在被另一个页面占用，请关闭重复打开的标注标签页');
    req.onerror=()=>reject(req.error||Error('数据库打开失败'));
    req.onsuccess=()=>{
      const db=req.result;
      db.onversionchange=()=>{db.close();if(state.db===db)state.db=null;setStatus('数据库版本改变，下一次操作自动重新连接')};
      db.onclose=()=>{if(state.db===db)state.db=null;setStatus('数据库连接已关闭；下一次读写将自动重连')};
      state.db=db;resolve(db);
    };
  }).finally(()=>{openingDB=null});
  return openingDB;
}
async function dbTransaction(stores,mode,operations){
  let db=await idb(),tx;
  try{tx=db.transaction(stores,mode)}
  catch(e){
    // Reopen only when creating the transaction failed, never re-run an in-flight write.
    if(!['InvalidStateError','TransactionInactiveError'].includes(e?.name))throw e;
    if(state.db===db)state.db=null;
    try{db.close()}catch(_){}
    db=await idb();tx=db.transaction(stores,mode);
  }
  return new Promise((resolve,reject)=>{
    let result,settled=false;
    const fail=e=>{if(!settled){settled=true;reject(e||tx.error||Error('数据库事务失败'))}};
    tx.oncomplete=()=>{if(!settled){settled=true;resolve(result)}};
    tx.onerror=()=>fail(tx.error);
    tx.onabort=()=>fail(tx.error||Error('数据库写入中断，请检查并重试'));
    try{operations(tx,v=>{result=v})}catch(e){try{tx.abort()}catch(_){}fail(e)}
  });
}
function dbGet(store,key){return dbTransaction([store],'readonly',(tx,set)=>{const r=tx.objectStore(store).get(key);r.onsuccess=()=>set(r.result)})}
function dbAll(store){return dbTransaction([store],'readonly',(tx,set)=>{const r=tx.objectStore(store).getAll();r.onsuccess=()=>set(r.result)})}
function dbPut(store,value){return dbTransaction([store],'readwrite',tx=>{tx.objectStore(store).put(value)})}
function dbPutPhotoRecord(photo,rec){return dbTransaction(['photos','records'],'readwrite',tx=>{tx.objectStore('photos').put(photo);tx.objectStore('records').put(rec)})}
function dbSaveDocRecord(doc,rec){return dbTransaction(['docs','records'],'readwrite',tx=>{tx.objectStore('docs').put(doc);tx.objectStore('records').put(rec)})}
function blankDoc(name){return {name,status:'pending',strokes:[],updated:new Date().toISOString()}}
async function loadQueue(){state.queue=(await dbAll('records')).sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));renderQueue()}
function renderQueue(){const counts={pending:0,annotated:0,negative:0};for(const q of state.queue)counts[q.status||'pending']++;$('counts').textContent=`${state.queue.length} 张｜有裂隙 ${counts.annotated}｜无裂隙 ${counts.negative}｜待画 ${counts.pending}`;const host=$('queue');host.replaceChildren();for(const rec of state.queue){const b=document.createElement('button');b.className='tile'+(rec.name===state.name?' current':'');const n=document.createElement('span');n.textContent=rec.name;const v=document.createElement('span');v.className=rec.status==='pending'?'wait':'ok';v.textContent=rec.status==='annotated'?'✓':rec.status==='negative'?'○':'·';b.append(n,v);b.onclick=()=>go(rec.name);host.appendChild(b)}}
// PNG IHDR contains the original dimensions. Parse 24 bytes instead of decoding
// a 20-50MP bitmap for every newly synchronized image (a major Safari memory win).
async function imgSize(blob){
  const header=new Uint8Array(await blob.slice(0,32).arrayBuffer());
  if(header.length>=24 && [137,80,78,71,13,10,26,10].every((v,i)=>header[i]===v)
       && String.fromCharCode(...header.slice(12,16))==='IHDR'){
    const v=new DataView(header.buffer,header.byteOffset,header.byteLength);
    const w=v.getUint32(16,false),h=v.getUint32(20,false);
    if(w>0&&h>0)return [w,h];
    throw Error('PNG尺寸无效');
  }
  // JPEG/WebP or unusual PNG: decode just long enough to read true dimensions.
  if('createImageBitmap' in window){const image=await createImageBitmap(blob);const dims=[image.width,image.height];image.close();return dims}
  return new Promise((resolve,reject)=>{const url=URL.createObjectURL(blob),im=new Image();im.onload=()=>{resolve([im.naturalWidth,im.naturalHeight]);URL.revokeObjectURL(url)};im.onerror=()=>{URL.revokeObjectURL(url);reject(Error('无法读取照片'))};im.src=url})
}
async function importOne(file){if(!/\.(png|jpe?g|webp)$/i.test(file.name))return 'skip';if(!crypto.subtle)throw Error('浏览器未提供安全的SHA-256校验；请使用HTTPS打开');const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());const sha256=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');const existing=state.queue.find(x=>x.name.toLowerCase()===file.name.toLowerCase());if(existing){if(existing.sha256&&existing.sha256!==sha256)throw Error(`${file.name} 与本机已有同名照片内容不同，禁止覆盖！`);return 'dup'}const [width,height]=await imgSize(file);if(!width||!height)throw Error(`${file.name} 图片无效`); // write photos before metadata; no record if interrupted
const rec={name:file.name,width,height,bytes:file.size,sha256,status:'pending',added:new Date().toISOString()};await dbPutPhotoRecord({name:file.name,blob:file},rec);state.queue.push(rec);return 'ok'}

// V3: cloud bytes are stored as supplied. Only one file at a time is held in memory.
// Name + byte-length checks prevent accidental mapping to another labeled image.
async function importCloudBlob(blob,name,expectedSize){
  if(!/\.(png|jpe?g|webp)$/i.test(name))throw Error('照片格式不支持：'+name);
  if(expectedSize && blob.size!==expectedSize)throw Error(name+' 传输长度不一致，已拒绝保存');
  const existing=state.queue.find(q=>q.name.toLowerCase()===name.toLowerCase());
  if(existing){
    if(existing.bytes&&existing.bytes!==blob.size)throw Error(name+' 本地与云端同名图片大小不同，禁止覆盖');
    return 'dup';
  }
  const [width,height]=await imgSize(blob);
  if(!(width>0&&height>0))throw Error(name+' 图片尺寸无法确认');
  const rec={name,width,height,bytes:blob.size,status:'pending',added:new Date().toISOString(),source:'supabase',cloud:{url:window.CaihuaApi.settings().url,owner:window.CaihuaApi.owner()}};
  await dbPutPhotoRecord({name,blob},rec);
  state.queue.push(rec);
  return 'ok';
}

async function importFiles(files){if(state.busy)return;state.busy=true;try{await loadQueue();let ok=0,dup=0,skip=0;for(let i=0;i<files.length;i++){setStatus(`正在导入 ${i+1}/${files.length}`);try{const r=await importOne(files[i]);if(r==='ok')ok++;else if(r==='dup')dup++;else skip++}catch(e){note(`导入 ${files[i].name} 失败：${e.message}`,9000);break}}await loadQueue();setStatus(`本机已接收 ${state.queue.length} 张`);note(`导入 ${ok} 张；重复 ${dup}；忽略 ${skip}。请检查 iPad 剩余空间。`,6500);if(!state.name&&state.queue.length)await go(state.queue[0].name)}finally{state.busy=false;await storageWarning()}}
async function importZip(file){if(file.size>260*1024*1024){alert('照片压缩包超过 260MB，请在 Mac 使用随包脚本拆成较小的分批 ZIP 后再导入。');return}if(state.busy)return;state.busy=true;try{setStatus('正在读取 ZIP…');const zip=await JSZip.loadAsync(file,{checkCRC32:true});const paths=Object.values(zip.files).filter(x=>!x.dir&&!x.name.startsWith('__MACOSX/')&&/\.(png|jpe?g|webp)$/i.test(x.name));if(paths.length>200)throw Error('每个 ZIP 建议不超过 200 张，请分批处理');await loadQueue();let ok=0,dup=0;for(let i=0;i<paths.length;i++){const entry=paths[i];const name=entry.name.split('/').pop();setStatus(`照片 ZIP ${i+1}/${paths.length}：${name}`);const data=await entry.async('blob');const ext=name.split('.').pop().toLowerCase();const type=ext==='png'?'image/png':ext==='webp'?'image/webp':'image/jpeg';const result=await importOne(new File([data],name,{type}));if(result==='ok')ok++;else if(result==='dup')dup++}await loadQueue();note(`ZIP 导入 ${ok} 张，重复 ${dup} 张`,6500);if(!state.name&&state.queue.length)await go(state.queue[0].name)}catch(e){alert('ZIP 导入中断：'+e.message+'。已成功导入的照片仍保存在 iPad。')}finally{state.busy=false;setStatus('本机存储就绪');await storageWarning()}}
async function storageWarning(){if(!navigator.storage?.estimate)return;try{const {usage,quota}=await navigator.storage.estimate();if(quota&&usage/quota>.72)note('警告：本地存储使用率较高，请马上导出备份，并分批处理照片',11000)}catch(e){}}
async function go(name){if(state.busy||state.saving)return;if(state.active){note('请先抬笔结束当前笔画');return}if(state.dirty&&!(await save()))return;const rec=state.queue.find(x=>x.name===name);if(!rec)return;state.name=name;state.doc=await dbGet('docs',name)||blankDoc(name);state.undo=[];state.redo=[];const saved=await dbGet('photos',name);if(!saved?.blob){alert('该照片未完整保存，请重新导入');return}if(state.url)URL.revokeObjectURL(state.url);state.url=URL.createObjectURL(saved.blob);state.image=null;const im=new Image();im.onload=()=>{if(state.name!==name)return;state.image=im;fit();renderQueue()};im.onerror=()=>alert('iPad 无法解码 '+name);im.src=state.url;$('currentName').textContent=name;setStatus('iPad 本地已载入')}
function fit(){if(!state.image)return;const r=$('view').getBoundingClientRect();state.zoom=Math.min(r.width/state.image.naturalWidth,r.height/state.image.naturalHeight)*.97;state.offsetX=(r.width-state.image.naturalWidth*state.zoom)/2;state.offsetY=(r.height-state.image.naturalHeight*state.zoom)/2;draw()}
function resized(){const toolbar=document.querySelector('.toolbar');$('view').style.top=Math.ceil(toolbar.getBoundingClientRect().height)+'px';const canvas=$('paint'),rect=$('view').getBoundingClientRect(),dpr=Math.min(window.devicePixelRatio||1,2.5);canvas.width=Math.max(1,Math.round(rect.width*dpr));canvas.height=Math.max(1,Math.round(rect.height*dpr));canvas.style.width=rect.width+'px';canvas.style.height=rect.height+'px';if(state.image)draw()}
function pt(e){const r=$('paint').getBoundingClientRect();return {x:(e.clientX-r.left-state.offsetX)/state.zoom,y:(e.clientY-r.top-state.offsetY)/state.zoom}}
function screenPt(e){const r=$('paint').getBoundingClientRect();return {x:e.clientX-r.left,y:e.clientY-r.top}}
// Keep legacy renderer unchanged for annotations made before this upgrade.
function drawRibbon(ctx,pts){if(!pts||!pts.length)return;ctx.beginPath();const r=p=>WIDTH_BASE+WIDTH_SCALE*Math.max(0,Math.min(1,p[2]??.5));if(pts.length===1){ctx.arc(pts[0][0],pts[0][1],r(pts[0]),0,Math.PI*2);ctx.fill();return}const left=[],right=[];for(let i=0;i<pts.length;i++){const [x,y]=pts[i];let dx,dy;if(i===0){dx=pts[1][0]-x;dy=pts[1][1]-y}else if(i===pts.length-1){dx=x-pts[i-1][0];dy=y-pts[i-1][1]}else{dx=pts[i+1][0]-pts[i-1][0];dy=pts[i+1][1]-pts[i-1][1]}const len=Math.hypot(dx,dy)||1,nx=-dy/len,ny=dx/len,rad=r(pts[i]);left.push([x+nx*rad,y+ny*rad]);right.push([x-nx*rad,y-ny*rad])}const a=(center,p)=>Math.atan2(p[1]-center[1],p[0]-center[0]);ctx.arc(pts[0][0],pts[0][1],r(pts[0]),a(pts[0],left[0]),a(pts[0],right[0]),true);for(const p of left)ctx.lineTo(p[0],p[1]);const last=pts.length-1;ctx.arc(pts[last][0],pts[last][1],r(pts[last]),a(pts[last],right[last]),a(pts[last],left[last]),false);for(let i=last;i>=0;i--)ctx.lineTo(right[i][0],right[i][1]);ctx.closePath();ctx.fill()}
// Draw a union of round dabs, not a self-intersecting offset polygon. Image-pixel
// spacing and pressure interpolation MUST match the Mac round-dabs-v2 exporter.
const SMOOTH_RENDERER='round-dabs-v2';
const PRESSURE_SMOOTH_DISTANCE=5; // original image px; damping isolated spikes
// On iPad Safari, the first pen pointerdown may have pressure 0 (unreported).
// Do not invent 0.5 (=23px wide!) for a very light touch. This is only used
// when the initial Apple Pencil pressure is missing; the usual 1..45px mapping
// and the round-dabs-v2 renderer remain unchanged.
const PEN_MISSING_START_PRESSURE=.02;
const PEN_TIP_CORRECTION_DISTANCE=7; // source-image pixels, not display pixels
const PEN_TIP_SPIKE_RATIO=1.8;
const PEN_TIP_SPIKE_DROP=.05;
function samplePressure(e,fallback=.5){return Number.isFinite(e.pressure)&&e.pressure>0&&e.pressure<=1?e.pressure:fallback}
function roundDabs(pts,cb){
  if(!pts?.length)return;
  const rad=p=>WIDTH_BASE+WIDTH_SCALE*Math.max(0,Math.min(1,p[2]??.5));
  let prev=pts[0],r0=rad(prev);cb(prev[0],prev[1],r0);
  for(let i=1;i<pts.length;i++){
    const next=pts[i],r1=rad(next),dx=next[0]-prev[0],dy=next[1]-prev[1],dist=Math.hypot(dx,dy);
    if(!Number.isFinite(dist)||!Number.isFinite(r1))continue;
    // Small radii need closer centers to avoid broken 1 px hairline cracks.
    const maxStep=Math.min(1.5,Math.max(.4,Math.min(r0,r1)*.8));
    const steps=Math.max(1,Math.ceil(dist/maxStep),Math.ceil(Math.abs(r1-r0)/.35));
    if(steps>100000)throw new Error('笔画坐标异常，请撤销并重新绘制');
    for(let k=1;k<=steps;k++){
      const t=k/steps;cb(prev[0]+dx*t,prev[1]+dy*t,r0+(r1-r0)*t);
    }
    prev=next;r0=r1;
  }
}
function drawRoundDabs(ctx,pts){
  if(!pts?.length)return;
  ctx.beginPath();
  roundDabs(pts,(x,y,r)=>{ctx.moveTo(x+r,y);ctx.arc(x,y,r,0,2*Math.PI,false)});
  ctx.fill();
}
function drawStroke(ctx,s){
  if(s.renderer===SMOOTH_RENDERER)drawRoundDabs(ctx,s.pts);
  else drawRibbon(ctx,s.pts);
}
// Spatial low-pass on pressure, NOT fixed-width painting. Avoid a 0-pressure
// pointer sample at lift-off being converted to 0.5 and forming a fat blob.
function addPenSample(s,ev){
  if(s.pointerId!==ev.pointerId&&typeof ev.pointerId==='number')return;
  const p=pt(ev),pts=s.pts,prev=pts[pts.length-1];
  if(!Number.isFinite(p.x)||!Number.isFinite(p.y))return;
  const d=Math.hypot(p.x-prev[0],p.y-prev[1]);
  // Correct a transient thick first dab while we still have the first 7
  // image pixels of a pen stroke in memory. The correction updates the
  // recorded pressure values, so the Mac JSON -> PNG renderer remains exact.
  // Never rewrite previous/saved strokes, and never alter pressure during
  // ordinary segments after this tiny pen-tip window.
  const validPressure=Number.isFinite(ev.pressure)&&ev.pressure>0&&ev.pressure<=1;
  if(s.penStart&&validPressure){
    const origin=pts[0];
    const fromStart=Math.hypot(p.x-origin[0],p.y-origin[1]);
    if(fromStart<=PEN_TIP_CORRECTION_DISTANCE){
      if(pts.length===1&&s.firstWasMissingPressure){
        pts[0][2]=ev.pressure;s.firstWasMissingPressure=false;
      }
      if(origin[2]>ev.pressure*PEN_TIP_SPIKE_RATIO
          && origin[2]-ev.pressure>=PEN_TIP_SPIKE_DROP){
        for(const q of pts){
          if(Math.hypot(q[0]-origin[0],q[1]-origin[1])<=PEN_TIP_CORRECTION_DISTANCE){
            q[2]=Math.min(q[2],ev.pressure);
          }
        }
      }
    }else{
      s.penStart=false;
    }
  }
  // Ignore sub-pixel sampling jitter, but retain genuine travel.
  if(d<Math.max(.25,.25/Math.max(.2,state.zoom)))return;
  const raw=samplePressure(ev,prev[2]);
  const alpha=1-Math.exp(-d/PRESSURE_SMOOTH_DISTANCE);
  const wanted=prev[2]+(raw-prev[2])*alpha;
  // A narrow spike in a sample cannot increase width by dozens of pixels.
  const maxDelta=Math.max(.005,(1.6*d)/(2*WIDTH_SCALE));
  const nextP=Math.max(0,Math.min(1,prev[2]+Math.max(-maxDelta,Math.min(maxDelta,wanted-prev[2]))));
  pts.push([p.x,p.y,nextP]);
}
function draw(){const canvas=$('paint');if(!canvas.width)return;const dpr=canvas.width/Math.max(1,canvas.getBoundingClientRect().width),ctx=canvas.getContext('2d');ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,canvas.width,canvas.height);if(!state.image)return;ctx.setTransform(dpr*state.zoom,0,0,dpr*state.zoom,dpr*state.offsetX,dpr*state.offsetY);ctx.drawImage(state.image,0,0);ctx.fillStyle='rgba(255,44,44,0.90)';for(const s of state.doc?.strokes||[])drawStroke(ctx,s);if(state.active)drawStroke(ctx,state.active);$('info').textContent=`${state.doc?.strokes?.length||0} 笔 · ${(state.zoom*100).toFixed(1)}% · 压感 1–45 px · 平滑版 V1.2`}
function queueUndo(){state.undo.push(JSON.stringify({strokes:state.doc.strokes,status:state.doc.status}));if(state.undo.length>100)state.undo.shift();state.redo=[]}
async function save(){
  if(!state.name||!state.doc)return true;
  if(state.saving)return false;
  state.saving=true;setStatus('正在保存到 iPad…');
  try{
    const doc={...state.doc,updated:new Date().toISOString()};
    const rec=state.queue.find(x=>x.name===state.name);
    if(!rec)throw Error('当前照片缺少对应的记录');
    const updatedRec={...rec,status:doc.status};
    // Atomic: a photo's doc and list status change together, or neither changes.
    await dbSaveDocRecord(doc,updatedRec);
    state.doc=doc;Object.assign(rec,updatedRec);state.dirty=false;
    setStatus('✓ 笔画已持久保存到 iPad');renderQueue();return true;
  }catch(e){
    setStatus('✕ 保存失败，禁止切换照片；先尝试重新保存并导出备份');
    alert('保存失败，当前笔画仍在页面内，请不要关闭或刷新：'+e.message);
    return false;
  }finally{state.saving=false}
}
async function commitChange(){state.dirty=true;draw();await save()}
function nearestStroke(p){const strokes=state.doc?.strokes||[];for(let i=strokes.length-1;i>=0;i--){const pts=strokes[i].pts;for(let j=0;j<pts.length;j++){const q=pts[j],rad=WIDTH_BASE+WIDTH_SCALE*(q[2]??.5)+Math.max(4,8/state.zoom);if(Math.hypot(p.x-q[0],p.y-q[1])<rad)return i}}return -1}
function touchDistance(){const xs=[...state.touches.values()];if(xs.length!==2)return null;return {cx:(xs[0].x+xs[1].x)/2,cy:(xs[0].y+xs[1].y)/2,dist:Math.hypot(xs[0].x-xs[1].x,xs[0].y-xs[1].y)}}
function zoomAt(f,cx,cy){const z=Math.max(.05,Math.min(10,state.zoom*f)),factor=z/state.zoom;state.offsetX=cx-(cx-state.offsetX)*factor;state.offsetY=cy-(cy-state.offsetY)*factor;state.zoom=z;draw()}
function pointerDown(e){
  if(!state.image||state.saving||state.busy)return;
  const canvas=$('paint');
  if(e.pointerType==='touch'){
    canvas.setPointerCapture(e.pointerId);state.touches.set(e.pointerId,screenPt(e));
    if(state.touches.size===2)state.pinch=touchDistance();return;
  }
  if(state.active)return;
  canvas.setPointerCapture(e.pointerId);
  if(state.tool==='erase'){
    const n=nearestStroke(pt(e));if(n>=0){queueUndo();state.doc.strokes.splice(n,1);state.doc.status=state.doc.strokes.length?'annotated':'pending';commitChange()}return;
  }
  const p=pt(e),isPen=e.pointerType==='pen';
  state.active={id:'mask_'+Date.now().toString(36)+'_'+Math.floor(Math.random()*1e5),
    renderer:SMOOTH_RENDERER,pointerId:e.pointerId,
    penStart:isPen,
    firstWasMissingPressure:!(e.pressure>0&&e.pressure<=1),
    pts:[[p.x,p.y,samplePressure(e,isPen?PEN_MISSING_START_PRESSURE:.5)]]};
  draw();e.preventDefault();
}
let paintingFrame=0;
function queuePaint(){if(paintingFrame)return;paintingFrame=requestAnimationFrame(()=>{paintingFrame=0;draw()})}
function pointerMove(e){
  if(e.pointerType==='touch'){
    if(!state.touches.has(e.pointerId))return;
    const old=state.touches.get(e.pointerId),now=screenPt(e);state.touches.set(e.pointerId,now);
    if(state.touches.size===2){const nowPinch=touchDistance();if(state.pinch&&nowPinch){const anchor={x:state.pinch.cx,y:state.pinch.cy};zoomAt(nowPinch.dist/state.pinch.dist,anchor.x,anchor.y);state.offsetX+=nowPinch.cx-state.pinch.cx;state.offsetY+=nowPinch.cy-state.pinch.cy}state.pinch=nowPinch}
    else{state.offsetX+=now.x-old.x;state.offsetY+=now.y-old.y;queuePaint()}
    return;
  }
  if(!state.active||state.active.pointerId!==e.pointerId)return;
  const collected=typeof e.getCoalescedEvents==='function'?e.getCoalescedEvents():[];
  const events=collected&&collected.length?collected:[e];
  for(const ev of events)addPenSample(state.active,ev);
  queuePaint();e.preventDefault();
}
async function pointerUp(e){
  if(e.pointerType==='touch'){state.touches.delete(e.pointerId);state.pinch=touchDistance();return}
  if(!state.active||state.active.pointerId!==e.pointerId)return;
  const stroke=state.active;state.active=null;
  // Do NOT use pointerup pressure (often zero). A tap becomes a 1px-distance dot.
  if(stroke.pts.length===1){const p=stroke.pts[0];stroke.pts.push([p[0]+.001,p[1]+.001,p[2]])}
  delete stroke.pointerId;delete stroke.firstWasMissingPressure;delete stroke.penStart;
  queueUndo();state.doc.strokes.push(stroke);state.doc.status='annotated';await commitChange();
}
async function setUndo(redo=false){if(state.busy||state.saving||!state.doc)return;const source=redo?state.redo:state.undo,target=redo?state.undo:state.redo;if(!source.length)return;target.push(JSON.stringify({strokes:state.doc.strokes,status:state.doc.status}));Object.assign(state.doc,JSON.parse(source.pop()));await commitChange()}
function setTool(t){state.tool=t;$('brush').classList.toggle('active',t==='brush');$('erase').classList.toggle('active',t==='erase')}
async function negative(){if(!state.doc||state.busy||state.saving)return;if(state.doc.strokes.length&&!confirm('当前照片存在裂隙笔画，确认无裂隙将清空它们。是否继续？'))return;queueUndo();state.doc.strokes=[];state.doc.status=state.doc.status==='negative'?'pending':'negative';await commitChange()}
async function navigate(delta){const i=state.queue.findIndex(x=>x.name===state.name);if(i<0)return;const n=i+delta;if(n>=0&&n<state.queue.length)await go(state.queue[n].name)}
function backupDoc(rec,doc){const stems=rec.name.replace(/\.[^.]+$/,'');return {image_id:stems,width:rec.width,height:rec.height,annotator:'ipad_offline',status:doc.status==='annotated'?'annotated':'pending',updated:doc.updated||new Date().toISOString(),boxes:[],masks:doc.strokes.map(s=>({id:s.id,class_id:1,type:'brush',points:s.pts,...(s.renderer===SMOOTH_RENDERER?{renderer:SMOOTH_RENDERER}:{})}))}}
// Segmented, recoverable JSON-only backups. The original JPEG/PNG is never loaded
// into memory during backup. Each batch has the full file manifest for safe merging.
const BACKUP_FILES_PER_PART=10;
const BACKUP_CHECKPOINT_KEY="caihua_json_backup_checkpoint_v2";
let backupPlan=null,backupPart=0;
async function makeBackupPlan(){
  const all=[],jobs=[];
  for(const rec of state.queue){
    const doc=await dbGet('docs',rec.name)||blankDoc(rec.name);
    if(doc.status==='annotated'&&!(doc.strokes||[]).length)throw Error(rec.name+' 标为有裂隙但没有笔画');
    if(doc.status==='negative'&&(doc.strokes||[]).length)throw Error(rec.name+' 标为无裂隙却含有笔画');
    all.push({name:rec.name,width:rec.width,height:rec.height,bytes:rec.bytes,sha256:rec.sha256,
      status:doc.status,stroke_count:(doc.strokes||[]).length,updated:doc.updated||null});
    if(['annotated','negative'].includes(doc.status))jobs.push({rec,status:doc.status,updated:doc.updated||null});
  }
  if(!jobs.length)throw Error('没有已完成标注或确认无裂隙的照片');
  const parts=[];
  for(let i=0;i<jobs.length;i+=BACKUP_FILES_PER_PART)parts.push(jobs.slice(i,i+BACKUP_FILES_PER_PART));
  // Stable snapshot ID even after the iPad unloads this tab while saving a ZIP.
  const bytes=new TextEncoder().encode(JSON.stringify(all.map(x=>[x.name,x.status,x.updated,x.sha256,x.stroke_count])));
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  const stamp='S'+Array.from(new Uint8Array(digest).slice(0,9),b=>b.toString(16).padStart(2,'0')).join('');
  return {all,parts,count:jobs.length,pending:all.length-jobs.length,stamp};
}
async function backup(){
  if(state.active){alert('请先抬笔，等待当前笔画保存完成，再生成备份');return;}
  if(state.busy||state.saving)return;
  if(state.latestBackup){alert('当前 JSON 备份尚未确认保存。请先点击「保存/分享备份」，确认文件实际存在后再点「确认已保存→下一包」。');return;}
  state.busy=true;
  try{
    if(state.dirty&&!(await save()))return;
    if(!backupPlan||backupPart>=backupPlan.parts.length){
      backupPlan=await makeBackupPlan();backupPart=0;
      try{
        const saved=JSON.parse(localStorage.getItem(BACKUP_CHECKPOINT_KEY)||'null');
        if(saved?.stamp===backupPlan.stamp && Number.isInteger(saved.part) && saved.part>=0 && saved.part<backupPlan.parts.length){
          backupPart=saved.part;setStatus(`恢复JSON备份进度：第${backupPart+1}/${backupPlan.parts.length}包`);
        }
      }catch(_){}
    }
    const partJobs=backupPlan.parts[backupPart];
    const zip=new JSZip();
    for(let i=0;i<partJobs.length;i++){
      const {rec,status,updated}=partJobs[i];
      setStatus(`生成JSON备份 ${backupPart+1}/${backupPlan.parts.length} 包，第 ${i+1}/${partJobs.length} 张：${rec.name}`);
      const doc=await dbGet('docs',rec.name)||blankDoc(rec.name);
      if(doc.status!==status||(doc.updated||null)!==updated)
        throw Error(`${rec.name} 自生成备份计划后又被修改。请保留之前的ZIP并重新开始新一轮完整备份，勿混合两个时间点的文件`);
      if(status==='annotated')zip.file('annotations/'+rec.name.replace(/\.[^.]+$/,'')+'.json',JSON.stringify(backupDoc(rec,doc)));
      if(i%2===0)await new Promise(resolve=>setTimeout(resolve,0));
    }
    const manifest={format:'caihua-ipad-offline-v1',created:new Date().toISOString(),
      brush:{min_width:1,max_width:45,base_radius:WIDTH_BASE,pressure_scale:WIDTH_SCALE,version:'smooth-v1.2',new_stroke_renderer:SMOOTH_RENDERER},
      batch:{version:2,part:backupPart+1,total:backupPlan.parts.length,complete:backupPlan.count,stamp:backupPlan.stamp},
      images:backupPlan.all};
    zip.file('offline_manifest.json',JSON.stringify(manifest));
    zip.file('READ_ME.txt','仅含标注JSON，不含照片。若备份分多包，请全部保存到同一Mac文件夹并使用稳定版Mac汇总脚本；勿混用不同批次的时间戳。');
    setStatus(`正在压缩 JSON 备份第 ${backupPart+1}/${backupPlan.parts.length} 包…`);
    const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:2}},meta=>{
      if(Math.round(meta.percent)%25===0)setStatus(`压缩中 ${Math.floor(meta.percent)}% · 第${backupPart+1}包`);
    });
    const part=String(backupPart+1).padStart(3,'0'),total=String(backupPlan.parts.length).padStart(3,'0');
    const name=`caihua_JSON_${backupPlan.stamp}_part_${part}_of_${total}.zip`;
    state.latestBackup={blob,name};$('shareBackup').disabled=false;
    setStatus(`✓ JSON第 ${backupPart+1}/${backupPlan.parts.length} 包已生成，点击「保存/分享备份」`);
    alert(`JSON 备份第 ${backupPart+1}/${backupPlan.parts.length} 包已经生成（${partJobs.length}张）。\n请点击「保存/分享备份」，存到 iCloud Drive，再核对 ZIP 存在。\n全部${backupPlan.count}张已完成，待画${backupPlan.pending}张不输出 Mask。`);
  }catch(e){setStatus('✕ JSON备份未完成：'+e.message);alert('JSON备份中断：'+e.message+'。之前成功保存的备份不受影响。');}
  finally{state.busy=false}
}
async function shareBackup(){
  const latest=state.latestBackup;
  if(!latest){alert('请先生成标注备份 ZIP');return}
  const {blob,name}=latest,file=new File([blob],name,{type:'application/zip'});
  if(navigator.share&&(!navigator.canShare||navigator.canShare({files:[file]}))){
    try{await navigator.share({files:[file],title:'彩画裂隙原始JSON备份'});
      $('nextBackup').disabled=false;note('请去“文件”App检查 ZIP 实际存在，确认后才进入下一包',10000);return;
    }catch(e){if(e.name==='AbortError')return;}
  }
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;
  document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),120000);
  $('nextBackup').disabled=false;note('已触发下载，请在文件App核验 ZIP 保存成功',10000);
}
function nextBackup(){
  if(state.busy)return;
  if(!state.latestBackup)return;
  if(!confirm('请先在 iPad“文件”App确认当前 JSON ZIP 已保存成功，再进入下一包。确认吗？'))return;
  state.latestBackup=null;$('shareBackup').disabled=true;$('nextBackup').disabled=true;backupPart++;
  if(backupPart<backupPlan.parts.length)localStorage.setItem(BACKUP_CHECKPOINT_KEY,JSON.stringify({stamp:backupPlan.stamp,part:backupPart}));
  else localStorage.removeItem(BACKUP_CHECKPOINT_KEY);
  if(backupPart>=backupPlan.parts.length){
    setStatus(`✓ ${backupPlan.count}张已完成标注，JSON备份共${backupPlan.parts.length}包已生成；请在文件App核对全部ZIP`);
    alert(`全部备份分包已完成：${backupPlan.parts.length}包。请确认文件齐全，传到Mac后统一生成原尺寸 Masks/Overlays。`);
    backupPlan=null;backupPart=0;
  }else setStatus(`JSON第 ${backupPart}/${backupPlan.parts.length} 包已保存，点击「生成标注备份ZIP」继续`);
}
async function init(){try{if(navigator.storage?.persist)navigator.storage.persist().catch(()=>{});state.db=await idb();await loadQueue();resized();setStatus('本地数据库已就绪');if('serviceWorker'in navigator){try{await navigator.serviceWorker.register('./sw.js',{scope:'./'});await navigator.serviceWorker.ready;setStatus('✓ 离线程序已就绪')}catch(e){setStatus('⚠ 未启用离线启动；请使用 HTTPS 安装');note('离线启动未就绪：'+e.message,10000)}}else note('此环境不支持离线 Service Worker，请用 iPad Safari 的 HTTPS 网页安装',9000);if(state.queue.length)await go(state.queue[0].name);await storageWarning()}catch(e){alert('初始化失败：'+e.message);setStatus('初始化错误')}
if(window.CaihuaCloud)window.CaihuaCloud.init();
$('files').onchange=async e=>{await importFiles([...e.target.files]);e.target.value=''};$('backup').onclick=backup;$('shareBackup').onclick=shareBackup;$('nextBackup').onclick=nextBackup;$('prev').onclick=()=>navigate(-1);$('next').onclick=()=>navigate(1);$('brush').onclick=()=>setTool('brush');$('erase').onclick=()=>setTool('erase');$('undo').onclick=()=>setUndo();$('redo').onclick=()=>setUndo(true);$('negative').onclick=negative;$('zoomIn').onclick=()=>zoomAt(1.5,$('paint').clientWidth/2,$('paint').clientHeight/2);$('zoomOut').onclick=()=>zoomAt(1/1.5,$('paint').clientWidth/2,$('paint').clientHeight/2);$('fit').onclick=fit;$('toggleList').onclick=()=>$('sidebar').classList.toggle('show');$('help').onclick=()=>$('modal').style.display='flex';$('closeHelp').onclick=()=>$('modal').style.display='none';const canvas=$('paint');canvas.addEventListener('pointerdown',pointerDown);canvas.addEventListener('pointermove',pointerMove);canvas.addEventListener('pointerup',pointerUp);canvas.addEventListener('pointercancel',pointerUp);window.addEventListener('resize',()=>{resized();if(state.image)fit()});if(window.ResizeObserver)new ResizeObserver(()=>{resized();if(state.image)fit()}).observe(document.querySelector('.toolbar'));window.addEventListener('pagehide',()=>{if(state.dirty)setStatus('警告：存在未保存笔画；请保持页面打开直到显示保存成功')});}
init();
