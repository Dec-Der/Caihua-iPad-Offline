/* Stable V2.0: online network-first, offline cache fallback, never cache Supabase API */
const CACHE='caihua-stable-v2-0-1-cloudlist';
const FILES=['./','./index.html','./app.js?v=2.0.1','./cloud.js?v=2.0.1','./jszip.min.js?v=2.0.0','./manifest.webmanifest','./icon.svg'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
 const keys=await caches.keys();
 for(const key of keys)if((key.startsWith('caihua-')||key.startsWith('caihua-offline-'))&&key!==CACHE)await caches.delete(key);
 await self.clients.claim();
})()));
self.addEventListener('fetch',event=>{
 const req=event.request,url=new URL(req.url);
 if(req.method!=='GET'||url.origin!==self.location.origin)return;
 event.respondWith((async()=>{
   try{
     const r=await fetch(req,{cache:'no-store'});
     if(r.ok){const store=await caches.open(CACHE);await store.put(req,r.clone());}
     return r;
   }catch(e){
     const cache=await caches.open(CACHE);
     const hit=await cache.match(req)|| (req.mode==='navigate'?await cache.match('./index.html'):null);
     if(hit)return hit;
     throw e;
   }
 })());
});
