let destinations=[],routes=[],quickRoutes=[],graph={},lastPath=[],mode="visitor";
let view={scale:1,x:0,y:0},dragging=false,dragStart=null;
const MAP_W=1024,MAP_H=768;
const $=id=>document.getElementById(id);
const loc=id=>destinations.find(d=>d.id===id);

async function init(){
  destinations=await fetch("data/destinations.json").then(r=>r.json());
  routes=await fetch("data/routes.json").then(r=>r.json());
  quickRoutes=await fetch("data/quick_routes.json").then(r=>r.json()).catch(()=>[]);
  buildGraph(); populateSelects(); renderQuickRoutes(); drawNetwork(); drawNodes(); wireEvents(); resetView(); setMode("visitor"); updateClock(); setInterval(updateClock,30000);
}

function buildGraph(){
  graph={}; destinations.forEach(d=>graph[d.id]=[]);
  routes.forEach(([a,b,w])=>{graph[a].push({id:b,weight:w});graph[b].push({id:a,weight:w});});
}

function populateSelects(){
  const s=$("startSelect"), e=$("endSelect");
  s.innerHTML=""; e.innerHTML="";
  destinations.forEach(d=>{s.add(new Option(d.name,d.id)); e.add(new Option(d.name,d.id));});
}

function renderQuickRoutes(){
  const wrap=$("quickRoutes"); wrap.innerHTML="";
  quickRoutes.forEach(q=>{
    const btn=document.createElement("button");
    btn.className="quick-route";
    btn.innerHTML=`<span>${q.label}</span><b>→</b>`;
    btn.onclick=()=>{$("startSelect").value=q.start;$("endSelect").value=q.end; if(q.mode) setMode(q.mode,false); generateRoute(); fitRoute();};
    wrap.appendChild(btn);
  });
}

function wireEvents(){
  $("routeBtn").onclick=generateRoute;
  $("zoomIn").onclick=()=>zoom(1.2);
  $("zoomOut").onclick=()=>zoom(.83);
  $("resetView").onclick=resetView;
  $("centerView").onclick=resetView;
  $("fitRoute").onclick=fitRoute;
  $("searchFocus").onclick=()=>$("searchBox").focus();
  $("fullscreenBtn").onclick=()=>document.documentElement.requestFullscreen?.();

  $("legendOpen").onclick=()=>$("legendPanel").classList.toggle("hide");
  $("legendClose").onclick=()=>$("legendPanel").classList.add("hide");
  $("layersOpen").onclick=()=>$("layersPanel").classList.toggle("show");
  $("layersClose").onclick=()=>$("layersPanel").classList.remove("show");

  $("labelsToggle").onchange=e=>toggleLabels(e.target.checked);
  $("networkToggle").onchange=e=>toggleNetwork(e.target.checked);
  $("pulseToggle").onchange=e=>$("overlay").classList.toggle("no-pulse",!e.target.checked);
  $("searchClear").onclick=()=>{$("searchBox").value="";$("searchResults").classList.remove("show");};

  document.querySelectorAll(".mode").forEach(b=>b.onclick=()=>setMode(b.dataset.mode));
  document.querySelectorAll("[data-layer]").forEach(cb=>cb.onchange=applyLayerFilters);

  $("searchBox").oninput=e=>renderSearch(e.target.value);
  $("shareBtn").onclick=shareRoute;
  $("directionsBtn").onclick=()=>{$("steps").scrollIntoView({behavior:"smooth",block:"nearest"});};

  const f=$("mapFrame");
  f.onwheel=e=>{e.preventDefault();zoom(e.deltaY<0?1.12:.89);};
  f.onmousedown=e=>{dragging=true;dragStart={x:e.clientX,y:e.clientY,vx:view.x,vy:view.y};f.classList.add("dragging");};
  window.onmousemove=e=>{if(!dragging)return;view.x=dragStart.vx+e.clientX-dragStart.x;view.y=dragStart.vy+e.clientY-dragStart.y;applyView();};
  window.onmouseup=()=>{dragging=false;f.classList.remove("dragging");};
  window.onresize=resetView;
}

function setMode(m, generate=true){
  mode=m;
  document.querySelectorAll(".mode").forEach(b=>b.classList.toggle("active",b.dataset.mode===m));
  if(m==="visitor"){
    $("startSelect").value="main_guard_house"; $("endSelect").value="visitor_badging"; $("subtitle").textContent="Visitor-safe guided routing";
  } else if(m==="employee"){
    $("startSelect").value="main_guard_house"; $("endSelect").value="formation"; $("subtitle").textContent="Employee pedestrian movement";
  } else if(m==="contractor"){
    $("startSelect").value="sub_guard_house"; $("endSelect").value="west_service_corridor"; $("subtitle").textContent="Contractor / trade access routing";
  } else {
    $("startSelect").value="center_junction"; $("endSelect").value="muster_center"; $("subtitle").textContent="Emergency reference routing";
  }
  if(generate) generateRoute();
}

function drawNetwork(){
  const l=$("networkLayer"); l.innerHTML="";
  routes.forEach(([a,b])=>{
    const A=loc(a), B=loc(b);
    const line=document.createElementNS("http://www.w3.org/2000/svg","line");
    line.setAttribute("x1",A.x); line.setAttribute("y1",A.y);
    line.setAttribute("x2",B.x); line.setAttribute("y2",B.y);
    line.setAttribute("class","network");
    l.appendChild(line);
  });
}

function drawNodes(){
  const l=$("nodeLayer"); l.innerHTML="";
  destinations.forEach(d=>{
    const g=document.createElementNS("http://www.w3.org/2000/svg","g");
    g.setAttribute("class",`node ${d.type}`);
    g.setAttribute("transform",`translate(${d.x},${d.y})`);
    g.dataset.id=d.id; g.dataset.type=d.type;
    g.innerHTML=`<circle class="pulse" r="0"></circle>
      <circle class="marker-ring" r="12"></circle>
      <circle class="marker-dot marker-core" r="8"></circle>
      <text x="16" y="-9">${escapeHtml(d.label)}</text>`;
    g.onclick=()=>{$("endSelect").value=d.id;showDestination(d.id);};
    l.appendChild(g);
  });
}

function dijkstra(start,end){
  const dist={},prev={},q=new Set(Object.keys(graph));
  Object.keys(graph).forEach(k=>dist[k]=Infinity); dist[start]=0;
  while(q.size){
    let u=[...q].sort((a,b)=>dist[a]-dist[b])[0]; q.delete(u);
    if(u===end) break;
    for(const n of graph[u]){
      const alt=dist[u]+n.weight;
      if(alt<dist[n.id]){dist[n.id]=alt;prev[n.id]=u;}
    }
  }
  const path=[]; let u=end;
  while(u){path.unshift(u);u=prev[u];}
  return {path,distance:dist[end]};
}

function generateRoute(){
  const start=$("startSelect").value, end=$("endSelect").value;
  if(!start||!end||start===end)return;
  const result=dijkstra(start,end);
  lastPath=result.path;
  drawRoute(result.path); updateRoute(result); showDestination(end);
}

function drawRoute(path){
  const l=$("routeLayer"); l.innerHTML="";
  const points=path.map(id=>`${loc(id).x},${loc(id).y}`).join(" ");
  const pl=document.createElementNS("http://www.w3.org/2000/svg","polyline");
  pl.setAttribute("points",points); pl.setAttribute("class","route"); pl.setAttribute("marker-end","url(#arrow)");
  l.appendChild(pl);
  document.querySelectorAll(".node").forEach(n=>n.classList.remove("selected"));
  path.forEach(id=>document.querySelector(`.node[data-id="${id}"]`)?.classList.add("selected"));
}

function updateRoute(r){
  const feet=Math.round(r.distance*1.7), mins=Math.max(1,Math.round(feet/250));
  $("routeStatus").textContent="AUTHORIZED";
  $("distanceMetric").textContent=feet+" ft"; $("timeMetric").textContent=mins+" min";
  $("sumDistance").textContent=feet+" ft"; $("sumTime").textContent=mins+" min";
  $("sumStart").textContent=loc(r.path[0]).name; $("sumEnd").textContent=loc(r.path.at(-1)).name;
  const steps=$("steps"); steps.innerHTML="";
  r.path.forEach((id,i)=>{
    const d=loc(id), el=document.createElement("div");
    el.className="step"; el.innerHTML=`<b>${i+1}. ${escapeHtml(d.name)}</b>${escapeHtml(d.description)}`;
    steps.appendChild(el);
  });
}

function showDestination(id){
  const d=loc(id);
  $("drawerTitle").textContent=d.name; $("drawerDesc").textContent=d.description;
  $("drawerAccess").textContent=d.access; $("drawerType").textContent=d.category;
  $("drawerEscort").textContent=d.access.toLowerCase().includes("visitor") ? "Required / As Assigned" : "As Required";
}

function renderSearch(q){
  q=q.toLowerCase().trim();
  const box=$("searchResults"); box.innerHTML="";
  if(q.length<2){box.classList.remove("show");return;}
  const matches=destinations.filter(d=>(d.name+" "+d.label+" "+d.category+" "+d.zone).toLowerCase().includes(q)).slice(0,8);
  matches.forEach(d=>{
    const btn=document.createElement("button");
    btn.innerHTML=`<b>${escapeHtml(d.name)}</b><br><small>${escapeHtml(d.category)} • ${escapeHtml(d.access)}</small>`;
    btn.onclick=()=>{$("endSelect").value=d.id;showDestination(d.id);box.classList.remove("show");};
    box.appendChild(btn);
  });
  box.classList.toggle("show",matches.length>0);
}

function applyLayerFilters(){
  const active={};
  document.querySelectorAll("[data-layer]").forEach(cb=>active[cb.dataset.layer]=cb.checked);
  document.querySelectorAll(".node").forEach(n=>n.classList.toggle("hidden-layer",active[n.dataset.type]===false));
}

function applyView(){ $("mapStage").style.transform=`translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px)) scale(${view.scale})`; }
function resetView(){ const f=$("mapFrame"); view.scale=Math.min(f.clientWidth/MAP_W,f.clientHeight/MAP_H)*.94; view.x=0; view.y=0; applyView(); }
function zoom(f){ view.scale=Math.max(.25,Math.min(5,view.scale*f)); applyView(); }
function fitRoute(){
  if(!lastPath.length)return;
  const f=$("mapFrame"), pts=lastPath.map(loc);
  const minX=Math.min(...pts.map(p=>p.x)), maxX=Math.max(...pts.map(p=>p.x)), minY=Math.min(...pts.map(p=>p.y)), maxY=Math.max(...pts.map(p=>p.y));
  const pad=130;
  view.scale=Math.min(f.clientWidth/(maxX-minX+pad*2), f.clientHeight/(maxY-minY+pad*2), 2.4);
  view.x=(MAP_W/2-(minX+maxX)/2)*view.scale; view.y=(MAP_H/2-(minY+maxY)/2)*view.scale; applyView();
}
function toggleLabels(show){$("overlay").classList.toggle("hide-labels",!show);}
function toggleNetwork(show){$("overlay").classList.toggle("hide-network",!show);}
function updateClock(){$("clock").textContent=new Date().toLocaleTimeString([],{hour:"numeric",minute:"2-digit"});}
function shareRoute(){
  const start=$("startSelect").value,end=$("endSelect").value;
  const url=`${location.origin}${location.pathname}?start=${start}&end=${end}`;
  navigator.clipboard?.writeText(url);
  showToast("Route link copied");
}
function showToast(msg){const t=$("toast");t.textContent=msg;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),1800);}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[m]));}
init();
