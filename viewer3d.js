import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";

const host=document.getElementById("threeCanvas");
const frame=document.getElementById("threeFrame");
const status=document.getElementById("threeStatus");
let renderer,labelRenderer,scene,camera,controls,model,resizeObserver;
let initialized=false,loading=false,visible=false;
const layerObjects={site:[],ground:[],mezzanine:[],roof:[]};
const buildingLabels=[];
const semanticLabels=[];
const floorLayerIndex=new Map();
let spatialOverrides={},routeGroup,routeCurve,tracker;
let routeProgress=0,trackingPaused=false,routeDuration=24,lastFrameTime=performance.now();
let editorActive=false,editorGroup,editorLine;
let editorNodes=[];
let pointerStart=null;
let animationFrameCount=0;
const raycaster=new THREE.Raycaster();
const pointer=new THREE.Vector2();
const EDITOR_STORAGE_KEY="pgs-v10-pedestrian-network-draft";

function setStatus(message,{error=false,hidden=false}={}){
  status.classList.toggle("error",error);
  status.classList.toggle("is-hidden",hidden);
  status.querySelector("span:last-child").textContent=message;
}

function initialize(){
  if(initialized)return;
  initialized=true;
  scene=new THREE.Scene();
  scene.background=new THREE.Color(0x071629);
  scene.fog=new THREE.Fog(0x071629,900,2800);

  camera=new THREE.PerspectiveCamera(45,1,.1,10000);
  camera.position.set(500,420,500);

  renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:"high-performance"});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.5));
  renderer.setSize(Math.max(host.clientWidth,1),Math.max(host.clientHeight,1),false);
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);

  labelRenderer=new CSS2DRenderer();
  labelRenderer.setSize(Math.max(host.clientWidth,1),Math.max(host.clientHeight,1));
  labelRenderer.domElement.className="three-label-layer";
  host.appendChild(labelRenderer.domElement);

  controls=new OrbitControls(camera,renderer.domElement);
  controls.enableDamping=true;
  controls.dampingFactor=.08;
  controls.screenSpacePanning=true;
  controls.maxPolarAngle=Math.PI*.49;

  scene.add(new THREE.HemisphereLight(0xdceeff,0x19334d,2.2));
  const sun=new THREE.DirectionalLight(0xffffff,2.6);
  sun.position.set(300,600,250);
  scene.add(sun);
  const grid=new THREE.GridHelper(2400,48,0x225a83,0x15344d);
  grid.material.opacity=.28;
  grid.material.transparent=true;
  scene.add(grid);

  resizeObserver=new ResizeObserver(resize);
  resizeObserver.observe(frame);
  document.querySelectorAll("[data-3d-layer]").forEach(input=>{
    input.addEventListener("change",()=>setLayerVisibility(input.dataset["3dLayer"],input.checked));
  });
  document.getElementById("threeLabelsToggle").addEventListener("change",event=>{
    frame.classList.toggle("three-labels-hidden",!event.target.checked);
  });
  document.querySelectorAll("[data-semantic-label]").forEach(input=>{
    input.addEventListener("change",updateSemanticLabelVisibility);
  });
  document.getElementById("threeRouteToggle").addEventListener("change",event=>{
    if(routeGroup)routeGroup.visible=event.target.checked;
  });
  document.getElementById("threeWalkToggle").addEventListener("click",toggleWalkPreview);
  document.getElementById("threeEditToggle").addEventListener("click",toggleRouteEditor);
  document.getElementById("threeEditUndo").addEventListener("click",undoEditorNode);
  document.getElementById("threeEditClear").addEventListener("click",clearEditorDraft);
  document.getElementById("threeEditSave").addEventListener("click",saveEditorDraft);
  document.getElementById("threeEditExport").addEventListener("click",exportEditorDraft);
  renderer.domElement.addEventListener("pointerdown",event=>{pointerStart={x:event.clientX,y:event.clientY};});
  renderer.domElement.addEventListener("pointerup",handleEditorPointerUp);
  window.addEventListener("pgs:route",event=>renderRoute(event.detail));
  animate();
}

async function loadModel(){
  if(model||loading)return;
  loading=true;
  setStatus("Preparing 3D twin…");
  try{
    const config=await fetch("data/config.json").then(response=>{
      if(!response.ok)throw new Error(`Configuration unavailable (${response.status})`);
      return response.json();
    });
    const modelUrl=config.views?.model||"assets/models/site_mobile.glb";
    const [destinationsPayload,labelsPayload,floorsPayload]=await Promise.all([
      fetch("data/generated/destination_spatial.json").then(response=>response.ok?response.json():{}).catch(()=>({})),
      fetch("data/generated/spatial_labels.json").then(response=>response.ok?response.json():{}).catch(()=>({})),
      fetch("data/generated/floor_layers.json").then(response=>response.ok?response.json():{}).catch(()=>({}))
    ]);
    spatialOverrides=destinationsPayload;
    floorLayerIndex.clear();
    (floorsPayload.layers||[]).forEach(layer=>floorLayerIndex.set(layer.floor_id,layer.code||"OUTDOOR"));
    const loader=new GLTFLoader();
    const gltf=await loader.loadAsync(modelUrl,event=>{
      if(event.total){
        const percent=Math.round(event.loaded/event.total*100);
        setStatus(`Loading 3D twin… ${percent}%`);
      }
    });
    model=gltf.scene;
    scene.add(model);
    fitModel();
    indexLayers();
    createBuildingLabels();
    createSemanticLabels(labelsPayload.labels||[]);
    restoreEditorDraft();
    applyInitialLayerState();
    if(window.pgsCurrentRoute)renderRoute(window.pgsCurrentRoute);
    setStatus("3D twin ready",{hidden:true});
  }catch(error){
    console.error("PGS 3D viewer:",error);
    setStatus("3D model is not available. Add the approved site_mobile.glb to assets/models and serve PGS locally.",{error:true});
  }finally{
    loading=false;
  }
}

function classifyLayer(name){
  if(/_RF(?:_|$)/i.test(name))return "roof";
  if(/_MF(?:_|$)/i.test(name))return "mezzanine";
  if(/_1F(?:_|$)/i.test(name))return "ground";
  return "site";
}

function indexLayers(){
  Object.values(layerObjects).forEach(items=>items.length=0);
  model.children.forEach(object=>layerObjects[classifyLayer(object.name)].push(object));
}

function setLayerVisibility(layer,isVisible){
  (layerObjects[layer]||[]).forEach(object=>object.visible=isVisible);
  buildingLabels.forEach(label=>{
    if(label.userData.layer===layer)label.visible=isVisible;
  });
  updateSemanticLabelVisibility();
}

function applyInitialLayerState(){
  document.querySelectorAll("[data-3d-layer]").forEach(input=>setLayerVisibility(input.dataset["3dLayer"],input.checked));
}

function buildingKey(name){
  return name.replace(/_(?:1F|MF|RF)(?:_|$).*$/i,"");
}

function buildingName(key){
  const known={
    Root_Main_Building_F38:"Main Production Building",
    Root_Main_Security_F44:"Main Guard House",
    Root_Secondary_Security_F43:"Secondary Guard House",
    "Root_F32-Discharge-Testing_F32":"Cell Discharge Testing",
    "Root_F34-Hazardous_Waste_Storage_F34":"Hazardous Storage",
    "Root_F41-Storage_F41":"Safety Building",
    "Root_F80-Ext._Building_between_1-2_F80":"Third Module Entrance",
    "Root_F105-Utility-PowerStation-2_F105":"Utility Power Station 2",
    "Root_F106-Utility-PowerStation_F106":"Utility Power Station"
  };
  return known[key]||key.replace(/^Root_/,"").replace(/_F\d+$/i,"").replace(/[_-]+/g," ");
}

function createBuildingLabels(){
  const groups=new Map();
  model.children.filter(object=>classifyLayer(object.name)==="ground").forEach(object=>{
    const key=buildingKey(object.name);
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(object);
  });
  groups.forEach((objects,key)=>{
    const candidates=objects.filter(object=>object.geometry);
    if(!candidates.length)return;
    candidates.forEach(object=>{
      if(!object.geometry.boundingBox)object.geometry.computeBoundingBox();
    });
    const volume=object=>{
      const size=object.geometry.boundingBox.getSize(new THREE.Vector3());
      return size.x*size.y*size.z;
    };
    const anchor=candidates.sort((a,b)=>volume(b)-volume(a))[0];
    const box=anchor.geometry.boundingBox;
    const center=box.getCenter(new THREE.Vector3());
    const size=box.getSize(new THREE.Vector3());
    center.y=box.max.y+Math.max(size.y*.25,2);
    const element=document.createElement("div");
    element.className="three-label";
    element.textContent=buildingName(key);
    const label=new CSS2DObject(element);
    label.position.copy(center);
    label.userData.layer="ground";
    anchor.add(label);
    buildingLabels.push(label);
  });
}

function semanticKind(kind){
  if(kind==="stair"||kind==="elevator")return "vertical";
  if(kind==="corridor"||kind==="amenity")return kind;
  return "room";
}

function semanticLayer(floorId){
  const code=floorLayerIndex.get(floorId)||"1F";
  if(code==="MF")return "mezzanine";
  if(code==="RF")return "roof";
  if(code==="OUTDOOR")return "site";
  return "ground";
}

function createSemanticLabels(records){
  records.forEach(record=>{
    const position=record.model_position;
    if(!position||![position.x,position.y,position.z].every(Number.isFinite))return;
    const layer=semanticLayer(record.floor_id);
    const category=layer==="site"?"area":semanticKind(record.kind);
    const element=document.createElement("div");
    element.className="three-semantic-label";
    element.dataset.kind=category;
    element.textContent=record.name;
    element.title=`${record.name} • ${record.review_status||"unreviewed"}`;
    const label=new CSS2DObject(element);
    label.position.set(position.x,position.y+1.5,position.z);
    label.userData={category,layer,record};
    label.visible=false;
    model.add(label);
    semanticLabels.push(label);
  });
  updateSemanticLabelVisibility();
}

function updateSemanticLabelVisibility(){
  const enabledCategories=new Set(
    [...document.querySelectorAll("[data-semantic-label]:checked")].map(input=>input.dataset.semanticLabel)
  );
  const enabledLayers=new Set(
    [...document.querySelectorAll("[data-3d-layer]:checked")].map(input=>input.dataset["3dLayer"])
  );
  semanticLabels.forEach(label=>{
    label.userData.enabled=enabledCategories.has(label.userData.category)&&enabledLayers.has(label.userData.layer);
  });
  updateSemanticLabelLOD();
}

function updateSemanticLabelLOD(){
  if(!model||!camera)return;
  const world=new THREE.Vector3();
  semanticLabels.forEach(label=>{
    const limit=label.userData.category==="room"||label.userData.category==="corridor"?260:420;
    label.getWorldPosition(world);
    label.visible=Boolean(label.userData.enabled)&&world.distanceTo(camera.position)<=limit;
  });
}

function destinationPosition(id){
  const value=(spatialOverrides.destinations||spatialOverrides)[id];
  if(!value)return null;
  const position=value.model_position||value;
  if(![position.x,position.y,position.z].every(Number.isFinite))return null;
  return new THREE.Vector3(position.x,Math.max(position.y,1.5),position.z);
}

function routePositions(route){
  if(Array.isArray(route?.spatialPath)&&route.spatialPath.length>1){
    return route.spatialPath
      .filter(position=>[position?.x,position?.y,position?.z].every(Number.isFinite))
      .map(position=>new THREE.Vector3(position.x,Math.max(position.y,1.5),position.z));
  }
  const destinations=route?.destinations||[];
  if(destinations.length<2)return [];
  const start=destinationPosition(destinations[0].id);
  const end=destinationPosition(destinations.at(-1).id);
  if(!start||!end)return [];
  const cumulative=[0];
  for(let index=1;index<destinations.length;index++){
    const previous=destinations[index-1],current=destinations[index];
    cumulative.push(cumulative.at(-1)+Math.hypot(current.x-previous.x,current.y-previous.y));
  }
  const total=cumulative.at(-1)||1;
  return destinations.map((destination,index)=>{
    const exact=destinationPosition(destination.id);
    if(exact)return exact;
    return start.clone().lerp(end,cumulative[index]/total);
  });
}

function disposeObject(object){
  object.traverse(child=>{
    child.geometry?.dispose?.();
    if(Array.isArray(child.material))child.material.forEach(material=>material.dispose?.());
    else child.material?.dispose?.();
  });
}

function clearRoute(){
  if(routeGroup){
    model?.remove(routeGroup);
    disposeObject(routeGroup);
  }
  routeGroup=routeCurve=tracker=null;
}

function marker(position,color,radius){
  const group=new THREE.Group();
  group.position.copy(position);
  const sphere=new THREE.Mesh(
    new THREE.SphereGeometry(radius,20,14),
    new THREE.MeshStandardMaterial({color,emissive:color,emissiveIntensity:.55,roughness:.3})
  );
  sphere.position.y=radius;
  group.add(sphere);
  const ring=new THREE.Mesh(
    new THREE.RingGeometry(radius*1.15,radius*1.65,28),
    new THREE.MeshBasicMaterial({color,transparent:true,opacity:.75,side:THREE.DoubleSide})
  );
  ring.rotation.x=-Math.PI/2;
  ring.position.y=.08;
  group.add(ring);
  return group;
}

function renderRoute(route){
  if(!model)return;
  clearRoute();
  const certified=route?.certified===true&&Array.isArray(route.spatialPath)&&route.spatialPath.length>1;
  const routeToggle=document.getElementById("threeRouteToggle");
  const routeStatus=document.getElementById("threeRouteStatus");
  if(!certified){
    routeToggle.checked=false;
    routeToggle.disabled=true;
    document.getElementById("threeWalkToggle").disabled=true;
    routeStatus.textContent="3D route hidden — trace and approve the pedestrian network first";
    return;
  }
  routeToggle.disabled=false;
  routeStatus.textContent="Approved pedestrian route loaded";
  const points=routePositions(route);
  const walkButton=document.getElementById("threeWalkToggle");
  if(points.length<2){
    walkButton.disabled=true;
    setStatus("This route does not yet have approved 3D destination anchors.",{error:true});
    return;
  }
  routeGroup=new THREE.Group();
  routeGroup.name="PGS_3D_ROUTE_PREVIEW";
  routeCurve=new THREE.CatmullRomCurve3(points,false,"centripetal",.35);
  const tube=new THREE.Mesh(
    new THREE.TubeGeometry(routeCurve,Math.max(64,points.length*28),1.15,10,false),
    new THREE.MeshStandardMaterial({color:0x0788ff,emissive:0x005dff,emissiveIntensity:1.3,roughness:.25})
  );
  routeGroup.add(tube);
  routeGroup.add(marker(points[0],0x35f59a,3.2));
  routeGroup.add(marker(points.at(-1),0x1687ff,3.2));
  tracker=marker(points[0],0xffcf3a,2.35);
  tracker.name="PGS_TRACKED_POSITION_PREVIEW";
  routeGroup.add(tracker);
  routeGroup.visible=document.getElementById("threeRouteToggle").checked;
  model.add(routeGroup);
  routeProgress=0;
  routeDuration=Math.max(12,Math.min(50,(route.distance||30)/2.5));
  trackingPaused=false;
  walkButton.disabled=false;
  walkButton.textContent="Pause Walk Preview";
  setStatus("3D route preview ready",{hidden:true});
  frameRoute(points);
}

function frameRoute(points){
  const box=new THREE.Box3().setFromPoints(points);
  const center=box.getCenter(new THREE.Vector3()).add(model.position);
  const size=box.getSize(new THREE.Vector3());
  const radius=Math.max(size.x,size.z,40);
  controls.target.copy(center);
  camera.position.set(center.x+radius*.75,center.y+radius*.65,center.z+radius*.75);
  controls.update();
}

function toggleWalkPreview(){
  if(!tracker)return;
  trackingPaused=!trackingPaused;
  document.getElementById("threeWalkToggle").textContent=trackingPaused?"Resume Walk Preview":"Pause Walk Preview";
}

function toggleRouteEditor(){
  if(!model)return;
  editorActive=!editorActive;
  controls.enabled=!editorActive;
  frame.classList.toggle("route-editing",editorActive);
  const button=document.getElementById("threeEditToggle");
  button.classList.toggle("active",editorActive);
  button.textContent=editorActive?"Finish Route Edit":"Start Route Edit";
  document.querySelector(".three-hint").textContent=editorActive
    ?"Click the center of each approved hallway or sidewalk segment"
    :"Drag to orbit • Scroll to zoom • Right-drag to pan";
  updateEditorControls();
}

function activeEditorLayer(){
  const selected=[...document.querySelectorAll("[data-3d-layer]:checked")].map(input=>input.dataset["3dLayer"]);
  return selected.includes("ground")?"ground":selected.includes("mezzanine")?"mezzanine":selected.includes("roof")?"roof":"site";
}

function handleEditorPointerUp(event){
  if(!editorActive||event.button!==0||!pointerStart)return;
  const movement=Math.hypot(event.clientX-pointerStart.x,event.clientY-pointerStart.y);
  pointerStart=null;
  if(movement>5)return;
  const rect=renderer.domElement.getBoundingClientRect();
  pointer.x=((event.clientX-rect.left)/rect.width)*2-1;
  pointer.y=-((event.clientY-rect.top)/rect.height)*2+1;
  raycaster.setFromCamera(pointer,camera);
  const hits=raycaster.intersectObject(model,true).filter(hit=>{
    const object=hit.object;
    return object.isMesh&&object.visible&&!routeGroup?.getObjectById(object.id)&&!editorGroup?.getObjectById(object.id);
  });
  if(!hits.length)return;
  const local=model.worldToLocal(hits[0].point.clone());
  local.y+=.35;
  editorNodes.push({
    id:`draft-node-${editorNodes.length+1}`,
    position:{x:+local.x.toFixed(4),y:+local.y.toFixed(4),z:+local.z.toFixed(4)},
    layer:activeEditorLayer(),
    access:["visitor","employee","contractor","emergency"],
    approved:false
  });
  rebuildEditorVisuals();
}

function ensureEditorGroup(){
  if(editorGroup)return;
  editorGroup=new THREE.Group();
  editorGroup.name="PGS_PEDESTRIAN_NETWORK_DRAFT";
  model.add(editorGroup);
}

function rebuildEditorVisuals(){
  ensureEditorGroup();
  while(editorGroup.children.length){
    const child=editorGroup.children.pop();
    child.traverse(descendant=>descendant.element?.remove?.());
    disposeObject(child);
  }
  const points=editorNodes.map(node=>new THREE.Vector3(node.position.x,node.position.y,node.position.z));
  points.forEach((position,index)=>{
    const nodeMarker=marker(position,0xef3340,2.1);
    nodeMarker.name=editorNodes[index].id;
    const element=document.createElement("div");
    element.className="three-semantic-label";
    element.dataset.kind="vertical";
    element.textContent=String(index+1);
    const numberLabel=new CSS2DObject(element);
    numberLabel.position.set(0,5,0);
    nodeMarker.add(numberLabel);
    editorGroup.add(nodeMarker);
  });
  if(points.length>1){
    editorLine=new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({color:0xef3340,linewidth:3})
    );
    editorLine.name="PGS_DRAFT_CENTERLINE";
    editorGroup.add(editorLine);
  }
  updateEditorControls();
}

function updateEditorControls(){
  const count=editorNodes.length;
  document.getElementById("threeEditStatus").textContent=`Draft: ${count} node${count===1?"":"s"}${editorActive?" • click model to add":""}`;
  ["threeEditUndo","threeEditClear","threeEditSave","threeEditExport"].forEach(id=>{
    document.getElementById(id).disabled=count===0;
  });
}

function undoEditorNode(){
  editorNodes.pop();
  rebuildEditorVisuals();
}

function clearEditorDraft(){
  editorNodes=[];
  localStorage.removeItem(EDITOR_STORAGE_KEY);
  rebuildEditorVisuals();
}

function editorPayload(){
  return {
    schema_version:"0.1.0-draft",
    coordinate_system:"PGS GLB model coordinates",
    review_status:"draft_requires_site_approval",
    nodes:editorNodes,
    edges:editorNodes.slice(1).map((node,index)=>({
      id:`draft-edge-${index+1}`,
      from:editorNodes[index].id,
      to:node.id,
      bidirectional:true,
      modes:["walking"],
      access:[...new Set([...editorNodes[index].access,...node.access])],
      approved:false
    }))
  };
}

function saveEditorDraft(){
  localStorage.setItem(EDITOR_STORAGE_KEY,JSON.stringify(editorPayload()));
  document.getElementById("threeEditStatus").textContent=`Draft saved locally • ${editorNodes.length} nodes`;
}

function restoreEditorDraft(){
  try{
    const saved=JSON.parse(localStorage.getItem(EDITOR_STORAGE_KEY)||"null");
    editorNodes=Array.isArray(saved?.nodes)?saved.nodes:[];
  }catch{
    editorNodes=[];
  }
  rebuildEditorVisuals();
}

function exportEditorDraft(){
  const blob=new Blob([JSON.stringify(editorPayload(),null,2)],{type:"application/json"});
  const link=document.createElement("a");
  link.href=URL.createObjectURL(blob);
  link.download=`pedestrian_network_draft_${new Date().toISOString().slice(0,10)}.json`;
  link.click();
  setTimeout(()=>URL.revokeObjectURL(link.href),1000);
}

function fitModel(){
  if(!model)return;
  const box=new THREE.Box3().setFromObject(model);
  if(box.isEmpty())return;
  const size=box.getSize(new THREE.Vector3());
  const center=box.getCenter(new THREE.Vector3());
  model.position.sub(center);
  model.position.y+=size.y/2;
  const radius=Math.max(size.x,size.y,size.z)*.72||100;
  camera.near=Math.max(radius/10000,.1);
  camera.far=Math.max(radius*20,5000);
  camera.position.set(radius*.82,radius*.62,radius*.82);
  camera.updateProjectionMatrix();
  controls.target.set(0,Math.max(size.y*.12,0),0);
  controls.minDistance=Math.max(radius*.08,1);
  controls.maxDistance=radius*5;
  controls.update();
  controls.saveState();
}

function resize(){
  if(!renderer||frame.hidden)return;
  const width=Math.max(host.clientWidth,1),height=Math.max(host.clientHeight,1);
  camera.aspect=width/height;
  camera.updateProjectionMatrix();
  renderer.setSize(width,height,false);
  labelRenderer.setSize(width,height);
}

function animate(){
  requestAnimationFrame(animate);
  if(!visible||!renderer)return;
  const now=performance.now();
  const delta=Math.min((now-lastFrameTime)/1000,.1);
  lastFrameTime=now;
  if(routeCurve&&tracker&&!trackingPaused&&routeGroup?.visible){
    routeProgress=(routeProgress+delta/routeDuration)%1;
    tracker.position.copy(routeCurve.getPointAt(routeProgress));
  }
  animationFrameCount=(animationFrameCount+1)%12;
  if(animationFrameCount===0)updateSemanticLabelLOD();
  controls.update();
  renderer.render(scene,camera);
  labelRenderer.render(scene,camera);
}

async function show(){
  visible=true;
  initialize();
  resize();
  await loadModel();
}

function hide(){ visible=false; }
function reset(){ if(controls){controls.reset();resize();} }

window.pgs3d={show,hide,reset};
