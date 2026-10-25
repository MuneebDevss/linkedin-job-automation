const api = globalThis.browser || globalThis.chrome;
const $ = id => document.getElementById(id);
const show = message => $('result').textContent = message;
api.storage.local.get('webhookUrl').then(s => { if(s.webhookUrl) $('url').value=s.webhookUrl; });
$('capture').onclick = async () => {
 try {
  const [tab] = await api.tabs.query({active:true,currentWindow:true});
  if(!tab?.url || !/^https:\/\/(www\.)?linkedin\.com\//.test(tab.url)) throw Error('Open a LinkedIn post first.');
  const [out] = await api.scripting.executeScript({target:{tabId:tab.id},func:() => {
   const selection = window.getSelection();
   const selected = selection?.toString().trim();
   let container = selection?.anchorNode?.parentElement?.closest('[data-urn^="urn:li:activity:"], .feed-shared-update-v2, article');
   const candidates = [...document.querySelectorAll('[data-urn^="urn:li:activity:"], .feed-shared-update-v2, article')].filter(x=>x.querySelector('.update-components-text, .feed-shared-update-v2__description'));
   if(!container && !selected) {
    const visible=candidates.filter(x=>{const r=x.getBoundingClientRect();return r.bottom>0 && r.top<innerHeight;});
    // Nested wrappers of the same post are not distinct posts.
    const unique=visible.filter(x=>!visible.some(y=>y!==x && y.contains(x)));
    if(unique.length!==1) throw Error('Select the text of ONE post, or open its individual post page.');
    container=unique[0];
   }
   const text=selected || container?.querySelector('.update-components-text, .feed-shared-update-v2__description')?.innerText?.trim();
   if(!text) throw Error('Post text not found. Select its text manually and capture again.');
   const urn=container?.getAttribute('data-urn');
   const permalink=container?.querySelector('a[href*="/feed/update/"],a[href*="/posts/"]')?.href;
   const url=permalink || (urn?.startsWith('urn:li:activity:') ? 'https://www.linkedin.com/feed/update/'+urn+'/' : location.href);
   const links=container ? [...new Set([...container.querySelectorAll('a[href]')].map(a=>a.href).filter(h=>/^https?:|^mailto:/i.test(h)))] : [];
   return {text,url,links};
  }});
  $('text').value=out.result.text; $('postUrl').value=out.result.url; $('links').value=out.result.links.join('\n');
  show('Captured. Review text, URL and links before sending.');
 } catch(e) { show(e.message); }
};
$('send').onclick=async()=>{
 $('send').disabled=true;
 try {
  const url=new URL($('url').value);
  if(url.protocol!=='http:' || !['localhost','127.0.0.1'].includes(url.hostname) || url.port!=='5678' || !/^\/webhook(?:-test)?\/linkedin-job\/?$/.test(url.pathname)) throw Error('This starter supports only the local n8n linkedin-job webhook on port 5678.');
  const text=$('text').value.trim(); if(!text) throw Error('Capture or paste a post first.');
  await api.storage.local.set({webhookUrl:url.href});
  const response=await fetch(url.href,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,url:$('postUrl').value.trim(),links:$('links').value.split('\n').map(x=>x.trim()).filter(Boolean),capturedAt:new Date().toISOString()}),signal:AbortSignal.timeout(20000)});
  if(!response.ok) throw Error('n8n returned HTTP '+response.status+'. For a test URL, click Listen for test event first.');
  show(JSON.stringify(await response.json(),null,2));
 } catch(e) {show(e.message+'\nIf connection failed: start n8n and check its webhook listener.');}
 finally {$('send').disabled=false;}
};
