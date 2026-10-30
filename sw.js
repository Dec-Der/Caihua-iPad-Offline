/* Caihua V3.0 - static shell only; photos / JSON remain in IndexedDB */
const CACHE='caihua-lean-v3-1-2-pencil-tip';
const ASSETS=['./','./index.html','./mac.html','./app.js?v=3.1.2','./cloud-core.js?v=3.1.0','./cloud.js?v=3.1.0','./mac-upload.js?v=3.1.0','./jszip.min.js?v=3.1.0','./cleanup-rules.js?v=3.1.0','./cleanup.js?v=3.1.0','./pending-cleanup.js?v=3.1.1','./icon.svg','./manifest.webmanifest'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('caihua-')&&key!==CACHE)await caches.delete(key);await self.clients.claim();})()));
self.addEventListener('fetch',e=>{
 const req=e.request,u=new URL(req.url);if(req.method!=='GET'||u.origin!==self.location.origin)return;
 e.respondWith((async()=>{
  try{const r=await fetch(req,{cache:'no-store'});if(r.ok){const c=await caches.open(CACHE);await c.put(req,r.clone())}return r}
  catch(err){const c=await caches.open(CACHE);const hit=await c.match(req)||(req.mode==='navigate'?await c.match('./index.html'):null);if(hit)return hit;throw err}
 })());
});
