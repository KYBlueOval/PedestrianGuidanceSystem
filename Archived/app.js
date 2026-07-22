let destinations=[],routes=[],quickRoutes=[],graph={},lastPath=[],mode="visitor";
let pedestrianNetwork=null,pedestrianGraph={},pedestrianNodes={},destinationNodeCrosswalk={};
let view={scale:1,x:0,y:0},dragging=false,dragStart=null;
let workspaceView="2d";
const MAP_W=1024,MAP_H=768;
const $=id=>document.getElementById(id);
const loc=id=>destinations.find(d=>d.id===id);
const fetchJson=url=>fetch(url,{cache:"no-store"});

async function init(){
  [destinations,routes,quickRoutes,pedestrianNetwork]=await Promise.all([
    fetchJson("data/destinations.json").then(r=>r.json()),
    fetchJson("data/routes.json").then(r=>r.json()),
    fetchJson("data/quick_routes.json").then(r=>r.json()).catch(()=>[]),
    fetchJson("data/generated/pedestrian_network.json").then(r=>r.ok?r.json():null).catch(()=>null)
  ]);
  const crosswalk=await fetchJson("data/generated/destination_node_crosswalk.json").then(r=>r.ok?r.json():null).catch(()=>null);
  destinationNodeCrosswalk=Object.fromEntries((crosswalk?.destinations||[]).map(item=>[item.destination_id,item.node_id]));
  buildGraph(); buildPedestrianGraph(); populateSelects(); renderQuickRoutes(); drawNetwork(); drawNodes(); wireEvents(); resetView(); setMode("visitor"); updateClock(); setInterval(updateClock,30000);
}

function buildGraph(){
  graph={}; destinations.forEach(d=>graph[d.id]=[]);
  routes.forEach(([a,b,w])=>{graph[a].push({id:b,weight:w});graph[b].push({id:a,weight:w});});
}

function destinationGroup(destination){
  if(destination.zone==="Visitor")return "Visitor / Check-In";
  if(destination.zone==="Security")return "Entrances / Security";
  if(destination.zone==="Production")return "Production Areas";
  if(destination.zone==="Amenities")return "Amenities / Employee Services";
  if(destination.zone==="Emergency")return "Emergency / Muster";
  return "Other";
}

function buildPedestrianGraph(){
  pedestrianGraph={}; pedestrianNodes={};
  if(pedestrianNetwork?.review?.route_ready!==true)return;
  (pedestrianNetwork.nodes||[]).forEach(node=>{pedestrianNodes[node.id]=node;pedestrianGraph[node.id]=[];});
  (pedestrianNetwork.edges||[]).forEach(edge=>{
    if(!pedestrianGraph[edge.from]||!pedestrianGraph[edge.to])return;
    const weight=Number(edge.distance)||distance3d(pedestrianNodes[edge.from].position,pedestrianNodes[edge.to].position);
    pedestrianGraph[edge.from].push({id:edge.to,weight,edge});
    if(edge.bidirectional!==false)pedestrianGraph[edge.to].push({id:edge.from,weight,edge});
  });
}

function distance3d(a,b){
  return Math.hypot((a?.x||0)-(b?.x||0),(a?.y||0)-(b?.y||0),(a?.z||0)-(b?.z||0));
}

function matchesDestinationCategory(destination,category){
  if(category==="all")return true;
  if(category==="visitor")return destination.zone==="Visitor"||destination.category.includes("Visitor");
  if(category==="security")return destination.zone==="Security";
  if(category==="production")return destination.zone==="Production";
  if(category==="amenities")return destination.zone==="Amenities";
  if(category==="emergency")return destination.zone==="Emergency";
  return true;
}

function addGroupedOptions(select,items){
  const groups=new Map();
  items.forEach(destination=>{
    const group=destinationGroup(destination);
    if(!groups.has(group))groups.set(group,[]);
    groups.get(group).push(destination);
  });
  groups.forEach((groupItems,label)=>{
    const optgroup=document.createElement("optgroup");
    optgroup.label=label;
    groupItems.sort((a,b)=>a.name.localeCompare(b.name)).forEach(destination=>{
      optgroup.appendChild(new Option(destination.name,destination.id));
    });
    select.appendChild(optgroup);
  });
}

function populateSelects(category=$("destinationCategory")?.value||"all"){
  const s=$("startSelect"), e=$("endSelect");
  const previousStart=s.value,previousEnd=e.value;
  s.innerHTML=""; e.innerHTML="";
  const selectable=destinations.filter(destination=>!["junction","corridor"].includes(destination.type));
  addGroupedOptions(s,selectable);
  addGroupedOptions(e,selectable.filter(destination=>matchesDestinationCategory(destination,category)));
  if([...s.options].some(option=>option.value===previousStart))s.value=previousStart;
  if([...e.options].some(option=>option.value===previousEnd))e.value=previousEnd;
}

function renderQuickRoutes(){
  const wrap=$("quickRoutes"); wrap.innerHTML="";
  quickRoutes.forEach(q=>{
    const btn=document.createElement("button");
    btn.className="quick-route";
    btn.innerHTML=`<span>${q.label}</span><b>→</b>`;
    btn.onclick=()=>{if(q.mode)setMode(q.mode,false);$("startSelect").value=q.start;$("endSelect").value=q.end;generateRoute();fitRoute();};
    wrap.appendChild(btn);
  });
}

function wireEvents(){
  $("routeBtn").onclick=generateRoute;
  $("destinationCategory").onchange=event=>populateSelects(event.target.value);
  $("zoomIn").onclick=()=>zoom(1.2);
  $("zoomOut").onclick=()=>zoom(.83);
  $("resetView").onclick=()=>workspaceView==="3d"?window.pgs3d?.reset():resetView();
  $("centerView").onclick=resetView;
  $("fitRoute").onclick=fitRoute;
  $("view2DBtn").onclick=()=>setWorkspaceView("2d");
  $("view3DBtn").onclick=()=>setWorkspaceView("3d");
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
  window.onresize=()=>{if(workspaceView==="2d")resetView();};
}

function setWorkspaceView(next){
  workspaceView=next==="3d"?"3d":"2d";
  const is3d=workspaceView==="3d";
  document.querySelector(".map-shell").classList.toggle("three-active",is3d);
  $("mapFrame").hidden=is3d;
  $("threeFrame").hidden=!is3d;
  $("view2DBtn").classList.toggle("active",!is3d);
  $("view3DBtn").classList.toggle("active",is3d);
  $("view2DBtn").setAttribute("aria-pressed",String(!is3d));
  $("view3DBtn").setAttribute("aria-pressed",String(is3d));
  ["zoomIn","zoomOut","centerView","fitRoute"].forEach(id=>$(id).disabled=is3d);
  if(is3d) window.pgs3d?.show();
  else { window.pgs3d?.hide(); resetView(); }
}

function setMode(m, generate=true){
  mode=m;
  document.querySelectorAll(".mode").forEach(b=>b.classList.toggle("active",b.dataset.mode===m));
  if(m==="visitor"){
    $("destinationCategory").value="visitor"; populateSelects("visitor");
    $("startSelect").value="main_guard_house"; $("endSelect").value="visitor_badging"; $("subtitle").textContent="Visitor-safe guided routing";
  } else if(m==="employee"){
    $("destinationCategory").value="production"; populateSelects("production");
    $("startSelect").value="main_guard_house"; $("endSelect").value="formation"; $("subtitle").textContent="Employee pedestrian movement";
  } else if(m==="contractor"){
    $("destinationCategory").value="production"; populateSelects("production");
    $("startSelect").value="sub_guard_house"; $("endSelect").value="anode"; $("subtitle").textContent="Contractor / trade access routing";
  } else {
    $("destinationCategory").value="emergency"; populateSelects("emergency");
    $("startSelect").value="employee_lobby"; $("endSelect").value="muster_center"; $("subtitle").textContent="Emergency reference routing";
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
    g.onclick=()=>{if(!["junction","corridor"].includes(d.type))$("endSelect").value=d.id;showDestination(d.id);};
    l.appendChild(g);
  });
}

function dijkstra(start,end,sourceGraph=graph){
  const dist={},prev={},q=new Set(Object.keys(sourceGraph));
  Object.keys(sourceGraph).forEach(k=>dist[k]=Infinity); dist[start]=0;
  while(q.size){
    let u=[...q].sort((a,b)=>dist[a]-dist[b])[0]; q.delete(u);
    if(u===end) break;
    for(const n of sourceGraph[u]||[]){
      if(sourceGraph===pedestrianGraph&&!edgeAllowsMode(n.edge,mode))continue;
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
  const startNode=destinationNodeCrosswalk[start],endNode=destinationNodeCrosswalk[end];
  const approvedNetwork=pedestrianNetwork?.review?.route_ready===true&&startNode&&endNode&&pedestrianGraph[startNode]&&pedestrianGraph[endNode];
  const spatialResult=approvedNetwork?dijkstra(startNode,endNode,pedestrianGraph):null;
  const spatialValid=spatialResult&&Number.isFinite(spatialResult.distance)&&spatialResult.path[0]===startNode&&spatialResult.path.at(-1)===endNode;
  const result=dijkstra(start,end);
  lastPath=result.path;
  const displayResult=spatialValid?{...result,distance:spatialResult.distance,distanceUnit:"meters",certified:true}:result;
  drawRoute(result.path); updateRoute(displayResult); showDestination(end);
  const routeDetail={
    path:[...result.path],
    destinations:result.path.map(id=>loc(id)),
    distance:displayResult.distance,
    distanceUnit:displayResult.distanceUnit||"map-units",
    certified:Boolean(spatialValid),
    spatialNodeIds:spatialValid?[...spatialResult.path]:[],
    spatialPath:spatialValid?spatialResult.path.map(id=>pedestrianNodes[id].position):[]
  };
  window.pgsCurrentRoute=routeDetail;
  window.dispatchEvent(new CustomEvent("pgs:route",{detail:routeDetail}));
}

function edgeAllowsMode(edge,currentMode){
  const allowed=(edge?.access||[]).map(value=>String(value).toLowerCase());
  if(!allowed.length||currentMode==="emergency")return true;
  return allowed.includes(currentMode)||allowed.includes("all")||allowed.includes("authorized");
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
  const feet=Math.round(r.distance*(r.distanceUnit==="meters"?3.28084:1.7)), mins=Math.max(1,Math.round(feet/250));
  $("routeStatus").textContent=r.certified?"APPROVED NETWORK":"DRAFT PREVIEW";
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
  const category=$("destinationCategory").value;
  const matches=destinations
    .filter(d=>!["junction","corridor"].includes(d.type))
    .filter(d=>matchesDestinationCategory(d,category))
    .filter(d=>(d.name+" "+d.label+" "+d.category+" "+d.zone).toLowerCase().includes(q))
    .sort((a,b)=>destinationGroup(a).localeCompare(destinationGroup(b))||a.name.localeCompare(b.name))
    .slice(0,10);
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
  if(workspaceView!=="2d")setWorkspaceView("2d");
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
