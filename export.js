/* 彩画裂隙 V1.3：iPad 本地生成二值灰度PNG、Overlay、标注JSON ZIP。
   不变更任何画笔/IndexedDB/Supabase逻辑；PNG栅格化遵循round-dabs-v2的6倍采样规则。
   重要：Canvas抗锯齿与Pillow椭圆像素化在少量边界像素上可能有差异。
 */
'use strict';
(()=>{
  const VERSION='ipad-png-export-v1.3';
  const SAMPLE=6, TILE_W=256, TILE_H=96;
  const MAX_PIXELS=16000000;
  const BATCH_PIXELS=16000000, BATCH_COUNT=3;
  const MAX_DABS_PER_STROKE=500000;
  const enc=new TextEncoder();
  let batchIndex=0, plan=null, latest=null, savedConfirmation=false;
  const btn=document.getElementById('exportPngZip');
  const shareBtn=document.getElementById('sharePngZip');
  const advanceBtn=document.getElementById('nextPngZip');
  if(!btn||!shareBtn||!advanceBtn) return;
  function waitUI(){return new Promise(resolve=>setTimeout(resolve,0));}
  function stamp(){return new Date().toISOString().replace(/[:.]/g,'-');}
  function status(s){setStatus(s); const p=document.getElementById('exportMessage'); if(p){p.textContent=s;}}
  function fail(message){alert('PNG 导出停止：'+message+'\n原有照片与标注不受影响。');status('⚠ 导出未完成：'+message);}
  function ensure(ok,msg){if(!ok)throw new Error(msg);}
  function getStem(name){return name.replace(/\.[^.]+$/,'');}
  function jsonDoc(rec,doc){return backupDoc(rec,doc);}
  function crc32(bytes){let crc=0xffffffff;for(const b of bytes){crc^=b;for(let j=0;j<8;j++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
  function put32(b,pos,v){b[pos]=(v>>>24)&255;b[pos+1]=(v>>>16)&255;b[pos+2]=(v>>>8)&255;b[pos+3]=v&255;}
  function pngChunk(type,data){const t=enc.encode(type),chunk=new Uint8Array(12+data.length);put32(chunk,0,data.length);chunk.set(t,4);chunk.set(data,8);const crcBytes=new Uint8Array(4+data.length);crcBytes.set(t);crcBytes.set(data,4);put32(chunk,8+data.length,crc32(crcBytes));return chunk;}
  // PNG bit depth 8, colour type 0 (grayscale); values only 0 or 255.
  // Store-only zlib internally; archive ZIP itself is DEFLATE compressed.
  function binaryMaskPNG(mask,w,h){
    const raw=new Uint8Array((w+1)*h);let n=0;
    for(let y=0;y<h;y++){let at=y*(w+1);raw[at++]=0;const row=y*w;for(let x=0;x<w;x++)raw[at+x]=mask[row+x]===1?255:0;n+=w;}
    const blocks=Math.ceil(raw.length/65535),zlib=new Uint8Array(raw.length+2+blocks*5+4);
    zlib[0]=0x78;zlib[1]=0x01;let pos=2;let a=1,b=0;
    for(let k=0;k<raw.length;k+=65535){const len=Math.min(65535,raw.length-k);zlib[pos++]=(k+len===raw.length)?1:0;zlib[pos++]=len&255;zlib[pos++]=len>>>8;zlib[pos++]=(~len)&255;zlib[pos++]=((~len)>>>8)&255;
      for(let j=0;j<len;j++){const v=raw[k+j];zlib[pos++]=v;a=(a+v)%65521;b=(b+a)%65521;}
    }
    put32(zlib,pos,((b<<16)|a)>>>0);
    const header=new Uint8Array(13);put32(header,0,w);put32(header,4,h);header[8]=8;header[9]=0;header[10]=0;header[11]=0;header[12]=0;
    const chunks=[new Uint8Array([137,80,78,71,13,10,26,10]),pngChunk('IHDR',header),pngChunk('IDAT',zlib),pngChunk('IEND',new Uint8Array())];
    return new Blob(chunks,{type:'image/png'});
  }
  function validStroke(s,rec,index){
    ensure(s&&s.renderer==='round-dabs-v2',`${rec.name} 第${index}笔不是V1.2 round-dabs-v2；旧笔画请先用Mac原版兼容导出器，切勿混用`);
    ensure(Array.isArray(s.pts)&&s.pts.length>=2,`${rec.name} 第${index}笔坐标缺失`);
    ensure(s.pts.length<=350000,`${rec.name} 第${index}笔过长，建议分段标注`);
    for(const p of s.pts)ensure(Array.isArray(p)&&p.length===3&&p.every(Number.isFinite)&&p[2]>=0&&p[2]<=1,`${rec.name} 第${index}笔存在无效坐标/压力`);
  }
  function makeMask(rec,doc){
    const w=rec.width,h=rec.height;
    ensure(Number.isInteger(w)&&Number.isInteger(h)&&w>0&&h>0&&w*h<=MAX_PIXELS,`${rec.name} 超过本次iPad安全导出像素限制 (${MAX_PIXELS} px)；请使用Mac导出`);
    const mask=new Uint8Array(w*h);
    if(doc.status==='negative') {ensure(!doc.strokes?.length,`${rec.name} 无裂隙状态仍有笔画，先复核`);return mask;}
    ensure(doc.status==='annotated'&&Array.isArray(doc.strokes)&&doc.strokes.length>0,`${rec.name} 并非已确认标注`);
    const nx=Math.ceil(w/TILE_W),ny=Math.ceil(h/TILE_H);
    for(let si=0;si<doc.strokes.length;si++){
      const s=doc.strokes[si];validStroke(s,rec,si+1);
      const bins=new Map();let dabs=0;
      // draw interpolation matches iPad display and Mac v1.2 exporter
      roundDabs(s.pts,(x,y,r)=>{
        if(++dabs>MAX_DABS_PER_STROKE)throw new Error(`${rec.name} 第${si+1}笔采样过多`);
        const x0=Math.max(0,Math.floor((x-r-1)/TILE_W)),x1=Math.min(nx-1,Math.floor((x+r+1)/TILE_W));
        const y0=Math.max(0,Math.floor((y-r-1)/TILE_H)),y1=Math.min(ny-1,Math.floor((y+r+1)/TILE_H));
        for(let ty=y0;ty<=y1;ty++)for(let tx=x0;tx<=x1;tx++){const key=ty*nx+tx;let list=bins.get(key);if(!list){list=[];bins.set(key,list);}list.push(x,y,r);}
      });
      for(const [key,list] of bins){
        const tx=key%nx,ty=Math.floor(key/nx),left=tx*TILE_W,top=ty*TILE_H;
        const cw=Math.min(TILE_W,w-left),ch=Math.min(TILE_H,h-top);
        const canvas=document.createElement('canvas');canvas.width=cw*SAMPLE;canvas.height=ch*SAMPLE;
        const ctx=canvas.getContext('2d',{willReadFrequently:true});ensure(!!ctx,'无法申请栅格化Canvas内存');ctx.fillStyle='#fff';
        for(let k=0;k<list.length;k+=3){const x=list[k],y=list[k+1],r=list[k+2];const cx=(x-left)*SAMPLE-.5,cy=(y-top)*SAMPLE-.5,rr=r*SAMPLE;
          // round-dabs-v2/Pillow exporter quantizes dab bounding boxes on the 6x grid.
          const loX=Math.round(cx-rr),hiX=Math.round(cx+rr),loY=Math.round(cy-rr),hiY=Math.round(cy+rr);
          if(hiX<0||loX>=canvas.width||hiY<0||loY>=canvas.height)continue;
          ctx.beginPath();ctx.ellipse((loX+hiX)/2,(loY+hiY)/2,Math.max(.001,(hiX-loX)/2),Math.max(.001,(hiY-loY)/2),0,0,2*Math.PI);ctx.fill();
        }
        const rgba=ctx.getImageData(0,0,canvas.width,canvas.height).data;
        const sw=canvas.width;
        for(let py=0;py<ch;py++)for(let px=0;px<cw;px++){
          let cov=0;const begin=((py*SAMPLE)*sw+px*SAMPLE)*4;
          for(let sy=0;sy<SAMPLE;sy++){const off=begin+sy*sw*4;for(let sx=0;sx<SAMPLE;sx++)cov+=rgba[off+sx*4+3];}
          if(cov*2>=SAMPLE*SAMPLE*255) mask[(top+py)*w+left+px]=1;
        }
        // Explicitly free temporary Safari canvas backing store before moving to next tile.
        canvas.width=0;canvas.height=0;
      }
    }
    ensure(mask.some(v=>v===1),`${rec.name} 有笔画但导出了空掩码；请检查坐标是否画在原图范围外`);
    return mask;
  }
  async function overlayPNG(imageBlob,mask,w,h){
    const bitmap=typeof createImageBitmap==='function'?await createImageBitmap(imageBlob):null;
    const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});ensure(!!ctx,'iPad无法创建原图Canvas');
    ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h);
    let tempUrl=null,tempImage=null;
    try{
      if(bitmap){ensure(bitmap.width===w&&bitmap.height===h,'原图尺寸与标注不一致');ctx.drawImage(bitmap,0,0);}
      else{tempUrl=URL.createObjectURL(imageBlob);tempImage=await new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=()=>reject(Error('无法解码原图'));im.src=tempUrl});ensure(tempImage.naturalWidth===w&&tempImage.naturalHeight===h,'原图尺寸与标注不一致');ctx.drawImage(tempImage,0,0);}
      const pixels=ctx.getImageData(0,0,w,h);
      for(let i=0;i<mask.length;i++)if(mask[i]){const o=i*4;pixels.data[o]=Math.round((pixels.data[o]+255)/2);pixels.data[o+1]=Math.round(pixels.data[o+1]/2);pixels.data[o+2]=Math.round(pixels.data[o+2]/2);pixels.data[o+3]=255;}
      ctx.putImageData(pixels,0,0);
      return await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('Overlay编码失败')),'image/png'));
    }finally{bitmap?.close();if(tempUrl)URL.revokeObjectURL(tempUrl);canvas.width=0;canvas.height=0;}
  }
  async function verifiedPhoto(rec){
    const saved=await dbGet('photos',rec.name);ensure(!!saved?.blob,`${rec.name} 原图未完整保存到本地，请先联网同步`);
    const [w,h]=await imgSize(saved.blob);ensure(w===rec.width&&h===rec.height,`${rec.name} 原图尺寸变化，拒绝错配Overlay`);
    // Do not require raw photo to be loaded into a browser tab. Hash original bytes for integrity.
    if(rec.sha256){const digest=await crypto.subtle.digest('SHA-256',await saved.blob.arrayBuffer());const hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');ensure(hash===rec.sha256,`${rec.name} 原图SHA-256校验失败`);}
    return saved.blob;
  }
  async function buildPlan(){
    const records=await dbAll('records');records.sort((a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true}));
    const output=[],stems=new Set();let pending=0;
    for(const rec of records){const doc=await dbGet('docs',rec.name)||blankDoc(rec.name);if(doc.status==='pending'){pending++;continue;}
      ensure(['annotated','negative'].includes(doc.status),`${rec.name} 存在无法识别的标注状态`);
      const stem=getStem(rec.name).toLowerCase();ensure(!stems.has(stem),`两张图片具有相同名称主体 ${stem}，会覆盖同名PNG，请改名后重新导入`);stems.add(stem);
      ensure(Number.isSafeInteger(rec.width)&&Number.isSafeInteger(rec.height)&&rec.width*rec.height<=MAX_PIXELS,`${rec.name} 过大，iPad可能因内存不足中断，请改在Mac导出`);
      if(doc.status==='annotated'){ensure(doc.strokes?.length>0,`${rec.name} 标记有裂隙但没有有效笔画`);for(let i=0;i<doc.strokes.length;i++)validStroke(doc.strokes[i],rec,i+1);}
      else ensure(!doc.strokes?.length,`${rec.name} 同时是无裂隙且有笔画，拒绝导出`);
      output.push({rec,status:doc.status,updated:doc.updated||null});
    }
    ensure(output.length>0,'没有完成标注的照片。请至少画一笔，或者明确点击“确认无裂隙”');
    const batches=[],batch=[];let size=0;
    for(const job of output){const pixels=job.rec.width*job.rec.height;if(batch.length&&(batch.length>=BATCH_COUNT||size+pixels>BATCH_PIXELS)){batches.push([...batch]);batch.length=0;size=0;}
      batch.push(job);size+=pixels;}
    if(batch.length)batches.push(batch);
    return {batches,pending,count:output.length};
  }
  function makeCSV(rows){return ['filename,width,height,status,strokes,white_pixels,mask,overlay',...rows.map(r=>[r.name,r.width,r.height,r.status,r.strokes,r.white_pixels,`masks/${getStem(r.name)}.png`,`overlays/${getStem(r.name)}.png`].join(','))].join('\n')+'\n';}
  function metaManifest(metadata){return {format:'caihua-ipad-offline-v1',export:'ipad-png-v1.3',created:new Date().toISOString(),brush:{min_width:1,max_width:45,base_radius:WIDTH_BASE,pressure_scale:WIDTH_SCALE,version:'smooth-v1.2',new_stroke_renderer:'round-dabs-v2'},images:metadata};}
  async function makeBatch(batch,i,total){
    const zip=new JSZip(),rows=[],meta=[];
    for(let j=0;j<batch.length;j++){
      const {rec,updated,status:expectedStatus}=batch[j]; const doc=await dbGet('docs',rec.name)||blankDoc(rec.name);ensure(doc.status===expectedStatus&&(doc.updated||null)===updated,`${rec.name} 在导出过程中又被修改，请重新打开页面并从头导出全部批次，避免旧标注和新标注混杂`);status(`正在处理第 ${i+1}/${total} 包：${j+1}/${batch.length} 张 ${rec.name}…`);await waitUI();
      const img=await verifiedPhoto(rec),mask=makeMask(rec,doc),maskBlob=binaryMaskPNG(mask,rec.width,rec.height);
      zip.file('masks/'+getStem(rec.name)+'.png',maskBlob,{binary:true});
      const overlayBlob=await overlayPNG(img,mask,rec.width,rec.height);
      zip.file('overlays/'+getStem(rec.name)+'.png',overlayBlob,{binary:true});
      if(doc.status==='annotated')zip.file('annotations/'+getStem(rec.name)+'.json',JSON.stringify(jsonDoc(rec,doc),null,2));
      rows.push({name:rec.name,width:rec.width,height:rec.height,status:doc.status,strokes:doc.strokes.length,white_pixels:mask.reduce((a,b)=>a+b,0)});meta.push({name:rec.name,width:rec.width,height:rec.height,bytes:rec.bytes,sha256:rec.sha256,status:doc.status,stroke_count:doc.strokes.length,updated:doc.updated});
      await waitUI();
    }
    zip.file('offline_manifest.json',JSON.stringify(metaManifest(meta),null,2));
    zip.file('export_report.csv',makeCSV(rows));
    zip.file('README_重要.txt',`含原尺寸二值灰度掩码 (0=背景,255=裂隙)、红色叠加Overlay、压感笔画JSON。\n已确认无裂隙的照片仅记录在offline_manifest.json，并输出全黑Mask。\n未标注照片不会生成全黑Mask。\nCanvas6倍采样与Mac Pillow在少量边界像素上可能略有差异；未经逐像素验收不得宣称两者完全相同。\n所有原照片与已保存标注仍在原设备数据库中。\n此包为第${i+1}/${total}包，请全部保存并核对。`);
    status(`正在压缩第 ${i+1}/${total} 包…`);await waitUI();
    const blob=await zip.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:2}});
    return {blob,name:`Caihua_masks_overlays_json_${String(i+1).padStart(3,'0')}_of_${String(total).padStart(3,'0')}_${stamp()}.zip`,count:batch.length};
  }
  async function exportClick(){
    if(state.busy||state.saving)return;
    try{
      if(state.dirty&&!(await save()))return;
      if(latest){alert('当前批次 ZIP 已生成。请先点击「保存/分享PNG ZIP」并确认文件保存成功；如果需要重新保存，仍可重复点击分享按钮。');return;}
      if(!plan){plan=await buildPlan();batchIndex=0;}
      ensure(batchIndex<plan.batches.length,'所有批次已经完成。如需重新导出，请刷新页面后重新生成（不会删除标注）');
      state.busy=true;btn.disabled=true;advanceBtn.disabled=true;
      latest=await makeBatch(plan.batches[batchIndex],batchIndex,plan.batches.length);
      shareBtn.disabled=false;
      status(`✓ 第${batchIndex+1}/${plan.batches.length}包已生成 (${latest.count}张)。现在点击「保存/分享PNG ZIP」；未标注${plan.pending}张未导出。`);
      alert(`第 ${batchIndex+1}/${plan.batches.length} 包已生成（${latest.count}张）。\n下一步点击「保存/分享PNG ZIP」，存入 iPad 文件或 iCloud Drive。\n\n注意：必须在“文件”App 中确认保存成功，才能点击「确认已保存→下一批」。`);
    }catch(e){fail(e?.message||String(e));}
    finally{state.busy=false;btn.disabled=false;}
  }
  async function shareClick(){if(!latest)return;const f=new File([latest.blob],latest.name,{type:'application/zip'});
    if(navigator.share&&(!navigator.canShare||navigator.canShare({files:[f]}))){try{await navigator.share({files:[f],title:'彩画裂隙 PNG Mask + Overlay + JSON'});advanceBtn.disabled=false;status('已打开分享界面；请到“文件”App核实ZIP确实保存后，再确认下一批');return;}catch(e){if(e.name==='AbortError')return;}}
    const url=URL.createObjectURL(latest.blob),a=document.createElement('a');a.href=url;a.download=latest.name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),120000);advanceBtn.disabled=false;status('已触发浏览器下载；请确认“文件”App中的ZIP存在，再进入下一批');
  }
  function nextBatch(){if(!latest)return;
    if(!confirm('请先打开 iPad“文件”确认当前 ZIP 已保存。确认已经保存成功，继续下一批吗？'))return;
    latest=null;shareBtn.disabled=true;advanceBtn.disabled=true;batchIndex++;
    if(batchIndex>=plan.batches.length){status(`✓ 全部 ${plan.count} 张、共 ${plan.batches.length} 包已处理。请逐包检查ZIP完整性。`);alert('所有批次已完成。请检查“文件”中ZIP数量，以及每包内 masks / overlays / annotations / offline_manifest.json。');}
    else{status(`已完成第${batchIndex}/${plan.batches.length}包。点击「生成PNG+Overlay+JSON ZIP」生成下一包。`);}
  }
  btn.addEventListener('click',exportClick);shareBtn.addEventListener('click',shareClick);advanceBtn.addEventListener('click',nextBatch);
  window.CaihuaExportTest={binaryMaskPNG,makeMask,version:VERSION};
})();
