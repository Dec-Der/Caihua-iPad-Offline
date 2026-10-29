'use strict';
// Pure verification rules, shared with the destructive-operation tests.
(()=>{
 function stable(value){
  if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';
  return JSON.stringify(value);
 }
 function coveredImages(manifest){
  if(manifest?.format!=='caihua-ipad-offline-v1'||!Array.isArray(manifest.images))throw Error('不是本平台的 JSON 备份');
  const b=manifest.batch,done=manifest.images.filter(x=>['annotated','negative'].includes(x.status));
  if(b?.version!==2||!Number.isInteger(b.part)||!Number.isInteger(b.total)||b.part<1||b.part>b.total||
    b.total!==Math.ceil(done.length/10)||b.complete!==done.length)throw Error('备份分包清单不完整或版本不支持');
  const names=new Set();
  for(const item of manifest.images){if(typeof item.name!=='string'||names.has(item.name))throw Error('备份有重名或无效文件');names.add(item.name)}
  return done.slice((b.part-1)*10,b.part*10);
 }
 function matches(rec,doc,entry,json,exported){
  if(!rec||!doc||!entry||!['annotated','negative'].includes(doc.status)||rec.status!==doc.status)return false;
  if(entry.name!==rec.name||entry.status!==doc.status||entry.width!==rec.width||entry.height!==rec.height||
    entry.bytes!==rec.bytes||(entry.updated||null)!==(doc.updated||null)||entry.stroke_count!==(doc.strokes||[]).length)return false;
  if(rec.sha256&&entry.sha256!==rec.sha256)return false;
  if(doc.status==='negative')return !(doc.strokes||[]).length;
  return !!doc.strokes?.length&&!!json&&stable(json)===stable(exported);
 }
 async function deleteOne(job,io){
  await io.assertCurrent(job);
  await io.checkCloud(job); // Compare original bytes before any deletion.
  await io.assertCurrent(job);
  if(job.remote)await io.removeCloud(job);
  // A 200/empty result can mean RLS denied the delete; verify absence.
  await io.assertCloudAbsent(job);
  await io.removeLocal(job);
 }
 window.CaihuaCleanupRules={stable,coveredImages,matches,deleteOne};
})();
