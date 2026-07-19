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
const sourceLabelObjects=new Map();
const floorLayerIndex=new Map();
let spatialOverrides={},routeGroup,routeCurve,tracker;
let routeProgress=0,trackingPaused=false,routeDuration=24,lastFrameTime=performance.now();
let editorActive=false,editorGroup;
let editorNodes=[],editorEdges=[],editorActiveNodeId=null,editorHistory=[];
let labelOverrides=[],labelOverrideGroup,labelPlacementActive=false;
let destinationDrafts=[],destinationDraftGroup,destinationPlacementActive=false;
let pointerStart=null;
let animationFrameCount=0;
const raycaster=new THREE.Raycaster();
const pointer=new THREE.Vector2();
const EDITOR_STORAGE_KEY="pgs-v10-pedestrian-network-draft";
const LABEL_STORAGE_KEY="pgs-v10-label-overrides-draft";
const DESTINATION_STORAGE_KEY="pgs-v10-destination-anchors-draft";

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
  document.getElementById("threeEditSegment").addEventListener("click",startEditorSegment);
  document.getElementById("threeEditDelete").addEventListener("click",deleteSelectedEditorNode);
  document.getElementById("threeEditClear").addEventListener("click",clearEditorDraft);
  document.getElementById("threeEditSave").addEventListener("click",saveEditorDraft);
  document.getElementById("threeEditExport").addEventListener("click",exportEditorDraft);
  document.getElementById("threeEditImport").addEventListener("click",()=>document.getElementById("threeEditImportFile").click());
  document.getElementById("threeEditImportFile").addEventListener("change",importEditorDraft);
  document.getElementById("threeLabelTarget").addEventListener("change",selectLabelTarget);
  document.getElementById("threeLabelPlace").addEventListener("click",startLabelPlacement);
  document.getElementById("threeLabelRemove").addEventListener("click",removeLabelOverride);
  document.getElementById("threeLabelSave").addEventListener("click",saveLabelOverrides);
  document.getElementById("threeLabelExport").addEventListener("click",exportLabelOverrides);
  document.getElementById("threeLabelImport").addEventListener("click",()=>document.getElementById("threeLabelImportFile").click());
  document.getElementById("threeLabelImportFile").addEventListener("change",importLabelOverrides);
  document.getElementById("threeDestinationSource").addEventListener("change",selectDestinationSource);
  document.getElementById("threeDestinationPlace").addEventListener("click",startDestinationPlacement);
  document.getElementById("threeDestinationRemove").addEventListener("click",removeDestinationDraft);
  document.getElementById("threeDestinationExport").addEventListener("click",exportDestinationDrafts);
  document.getElementById("threeDestinationImport").addEventListener("click",()=>document.getElementById("threeDestinationImportFile").click());
  document.getElementById("threeDestinationImportFile").addEventListener("change",importDestinationDrafts);
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
    const config=await fetch("data/config.json",{cache:"no-store"}).then(response=>{
      if(!response.ok)throw new Error(`Configuration unavailable (${response.status})`);
      return response.json();
    });
    const modelUrl=config.views?.model||"assets/models/site_mobile.glb";
    const [destinationsPayload,labelsPayload,floorsPayload]=await Promise.all([
      fetch("data/generated/destination_spatial.json",{cache:"no-store"}).then(response=>response.ok?response.json():{}).catch(()=>({})),
      fetch("data/generated/spatial_labels.json",{cache:"no-store"}).then(response=>response.ok?response.json():{}).catch(()=>({})),
      fetch("data/generated/floor_layers.json",{cache:"no-store"}).then(response=>response.ok?response.json():{}).catch(()=>({}))
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
    restoreLabelOverrides();
    restoreEditorDraft();
    restoreDestinationDrafts();
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
    if(label.userData.layer===layer)label.visible=isVisible&&!label.userData.overridden;
  });
  (labelOverrideGroup?.children||[]).forEach(label=>{
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
    // Guard-house positions are authored in XEUS and are more reliable than a
    // mesh bounding-box center. Their semantic labels are created below.
    if(["Root_Main_Security_F44","Root_Secondary_Security_F43"].includes(key))return;
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
    label.userData={layer:"ground",labelId:`building:${key}`,displayName:buildingName(key),category:"building"};
    anchor.add(label);
    buildingLabels.push(label);
    sourceLabelObjects.set(label.userData.labelId,label);
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
    const guardHouse=/^(MAIN|SUB) GUARD HOUSE/i.test(record.name||"");
    const layer=semanticLayer(record.floor_id);
    const category=guardHouse?"area":layer==="site"?"area":semanticKind(record.kind);
    const element=document.createElement("div");
    element.className="three-semantic-label";
    element.dataset.kind=category;
    element.textContent=guardHouse
      ? (/^MAIN/i.test(record.name)?"Main Guard House":"Secondary Guard House")
      : record.name;
    element.title=`${record.name} • ${record.review_status||"unreviewed"}`;
    const label=new CSS2DObject(element);
    label.position.set(position.x,position.y+1.5,position.z);
    label.userData={category,layer,record,labelId:record.id,displayName:element.textContent};
    label.visible=false;
    model.add(label);
    semanticLabels.push(label);
    if(category!=="room")sourceLabelObjects.set(label.userData.labelId,label);
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
    label.visible=!label.userData.overridden&&Boolean(label.userData.enabled)&&world.distanceTo(camera.position)<=limit;
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
  if(labelPlacementActive)cancelLabelPlacement();
  if(destinationPlacementActive)cancelDestinationPlacement();
  editorActive=!editorActive;
  controls.enabled=!editorActive;
  frame.classList.toggle("route-editing",editorActive);
  const button=document.getElementById("threeEditToggle");
  button.classList.toggle("active",editorActive);
  button.textContent=editorActive?"Finish Mapping":"Start Mapping";
  document.querySelector(".three-hint").textContent=editorActive
    ?"Click the centerline at every walkway turn or intersection"
    :"Drag to orbit • Scroll to zoom • Right-drag to pan";
  rebuildEditorVisuals();
}

function activeEditorLayer(){
  const selected=[...document.querySelectorAll("[data-3d-layer]:checked")].map(input=>input.dataset["3dLayer"]);
  return selected.includes("ground")?"ground":selected.includes("mezzanine")?"mezzanine":selected.includes("roof")?"roof":"site";
}

function handleEditorPointerUp(event){
  if((!editorActive&&!labelPlacementActive&&!destinationPlacementActive)||event.button!==0||!pointerStart)return;
  const movement=Math.hypot(event.clientX-pointerStart.x,event.clientY-pointerStart.y);
  pointerStart=null;
  if(movement>5)return;
  const rect=renderer.domElement.getBoundingClientRect();
  pointer.x=((event.clientX-rect.left)/rect.width)*2-1;
  pointer.y=-((event.clientY-rect.top)/rect.height)*2+1;
  raycaster.setFromCamera(pointer,camera);
  if(destinationPlacementActive){
    const destinationHits=raycaster.intersectObject(model,true).filter(hit=>{
      const object=hit.object;
      return object.isMesh&&object.visible&&!routeGroup?.getObjectById(object.id)&&!editorGroup?.getObjectById(object.id);
    });
    if(destinationHits.length)placeDestinationDraft(model.worldToLocal(destinationHits[0].point.clone()));
    return;
  }
  if(labelPlacementActive){
    const labelHits=raycaster.intersectObject(model,true).filter(hit=>{
      const object=hit.object;
      return object.isMesh&&object.visible&&!routeGroup?.getObjectById(object.id)&&!editorGroup?.getObjectById(object.id);
    });
    if(labelHits.length)placeLabelOverride(model.worldToLocal(labelHits[0].point.clone()));
    return;
  }
  const selectedHit=(editorGroup?raycaster.intersectObject(editorGroup,true):[]).find(hit=>editorNodeId(hit.object));
  if(selectedHit){
    const selectedId=editorNodeId(selectedHit.object);
    if(editorActiveNodeId&&selectedId!==editorActiveNodeId&&!editorEdges.some(edge=>
      (edge.from===editorActiveNodeId&&edge.to===selectedId)||(edge.from===selectedId&&edge.to===editorActiveNodeId)
    )){
      pushEditorHistory();
      const source=editorNodes.find(node=>node.id===editorActiveNodeId);
      const target=editorNodes.find(node=>node.id===selectedId);
      const settings=activeWalkwaySettings();
      editorEdges.push({
        id:nextEditorId("edge",editorEdges),from:source.id,to:target.id,bidirectional:true,
        modes:["walking"],kind:settings.kind,access:settings.access,accessible:settings.accessible,approved:false
      });
    }
    editorActiveNodeId=selectedId;
    rebuildEditorVisuals();
    return;
  }
  const hits=raycaster.intersectObject(model,true).filter(hit=>{
    const object=hit.object;
    return object.isMesh&&object.visible&&!routeGroup?.getObjectById(object.id)&&!editorGroup?.getObjectById(object.id);
  });
  if(!hits.length)return;
  const local=model.worldToLocal(hits[0].point.clone());
  local.y+=.35;
  pushEditorHistory();
  const settings=activeWalkwaySettings();
  const node={
    id:nextEditorId("node",editorNodes),
    position:{x:+local.x.toFixed(4),y:+local.y.toFixed(4),z:+local.z.toFixed(4)},
    layer:activeEditorLayer(),
    access:settings.access,
    accessible:settings.accessible,
    approved:false
  };
  editorNodes.push(node);
  if(editorActiveNodeId){
    const source=editorNodes.find(candidate=>candidate.id===editorActiveNodeId);
    if(source)editorEdges.push({
      id:nextEditorId("edge",editorEdges),from:source.id,to:node.id,bidirectional:true,
      modes:["walking"],kind:settings.kind,access:settings.access,accessible:settings.accessible,approved:false
    });
  }
  editorActiveNodeId=node.id;
  rebuildEditorVisuals();
}

function activeWalkwaySettings(){
  const accessProfile=document.getElementById("threeWalkwayAccess").value;
  return {
    kind:document.getElementById("threeWalkwayKind").value,
    access:accessProfile==="all"?["visitor","employee","contractor","emergency"]:[accessProfile],
    accessible:document.getElementById("threeWalkwayAccessible").checked
  };
}

function editorNodeId(object){
  let current=object;
  while(current&&current!==editorGroup){
    if(current.userData?.editorNodeId)return current.userData.editorNodeId;
    current=current.parent;
  }
  return null;
}

function nextEditorId(kind,items){
  const highest=items.reduce((max,item)=>Math.max(max,Number(String(item.id||"").match(/(\d+)$/)?.[1]||0)),0);
  return `draft-${kind}-${highest+1}`;
}

function pushEditorHistory(){
  editorHistory.push(JSON.stringify({nodes:editorNodes,edges:editorEdges,active:editorActiveNodeId}));
  if(editorHistory.length>100)editorHistory.shift();
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
  const nodeIndex=new Map(editorNodes.map(node=>[node.id,node]));
  editorEdges.forEach(edge=>{
    const source=nodeIndex.get(edge.from),target=nodeIndex.get(edge.to);
    if(!source||!target)return;
    const line=new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(source.position.x,source.position.y,source.position.z),
        new THREE.Vector3(target.position.x,target.position.y,target.position.z)
      ]),
      new THREE.LineBasicMaterial({color:0xef3340,linewidth:3})
    );
    line.name=edge.id;
    editorGroup.add(line);
  });
  if(editorActive)editorNodes.forEach((node,index)=>{
    const position=new THREE.Vector3(node.position.x,node.position.y,node.position.z);
    const selected=node.id===editorActiveNodeId;
    const nodeMarker=marker(position,selected?0xffcf3a:0xef3340,selected?2.8:2.1);
    nodeMarker.name=node.id;
    nodeMarker.userData.editorNodeId=node.id;
    const element=document.createElement("div");
    element.className="three-semantic-label";
    element.dataset.kind="vertical";
    element.textContent=String(index+1);
    const numberLabel=new CSS2DObject(element);
    numberLabel.position.set(0,5,0);
    nodeMarker.add(numberLabel);
    editorGroup.add(nodeMarker);
  });
  updateEditorControls();
  persistEditorDraft();
}

function updateEditorControls(){
  const count=editorNodes.length;
  const selected=editorActiveNodeId?` • selected ${editorActiveNodeId.replace("draft-node-","")}`:" • next click starts a segment";
  document.getElementById("threeEditStatus").textContent=editorActive
    ?`Editing network: ${count} control points / ${editorEdges.length} walkway sections${selected}`
    :`Walking-path layer: ${editorEdges.length} sections • control points hidden`;
  ["threeEditClear","threeEditSave","threeEditExport"].forEach(id=>{
    document.getElementById(id).disabled=count===0;
  });
  document.getElementById("threeEditUndo").disabled=editorHistory.length===0;
  document.getElementById("threeEditSegment").disabled=!editorActiveNodeId;
  document.getElementById("threeEditDelete").disabled=!editorActiveNodeId;
}

function undoEditorNode(){
  const previous=editorHistory.pop();
  if(!previous)return;
  const state=JSON.parse(previous);
  editorNodes=state.nodes||[];
  editorEdges=state.edges||[];
  editorActiveNodeId=state.active||null;
  rebuildEditorVisuals();
}

function startEditorSegment(){
  editorActiveNodeId=null;
  rebuildEditorVisuals();
}

function deleteSelectedEditorNode(){
  if(!editorActiveNodeId)return;
  pushEditorHistory();
  editorNodes=editorNodes.filter(node=>node.id!==editorActiveNodeId);
  editorEdges=editorEdges.filter(edge=>edge.from!==editorActiveNodeId&&edge.to!==editorActiveNodeId);
  editorActiveNodeId=null;
  rebuildEditorVisuals();
}

function clearEditorDraft(){
  pushEditorHistory();
  editorNodes=[];
  editorEdges=[];
  editorActiveNodeId=null;
  localStorage.removeItem(EDITOR_STORAGE_KEY);
  rebuildEditorVisuals();
}

function editorPayload(){
  return {
    schema_version:"0.2.0-draft",
    coordinate_system:"PGS GLB model coordinates",
    authoring_mode:"pedestrian_network_mapping",
    review_status:"draft_requires_site_approval",
    nodes:editorNodes,
    edges:editorEdges
  };
}

function saveEditorDraft(){
  persistEditorDraft();
  document.getElementById("threeEditStatus").textContent=`Network saved locally • ${editorNodes.length} nodes / ${editorEdges.length} walkways`;
}

function persistEditorDraft(){
  try{
    localStorage.setItem(EDITOR_STORAGE_KEY,JSON.stringify(editorPayload()));
  }catch(error){
    console.warn("Could not auto-save pedestrian network draft",error);
  }
}

function restoreEditorDraft(){
  try{
    const saved=JSON.parse(localStorage.getItem(EDITOR_STORAGE_KEY)||"null");
    editorNodes=Array.isArray(saved?.nodes)?saved.nodes:[];
    editorEdges=(Array.isArray(saved?.edges)?saved.edges:editorNodes.slice(1).map((node,index)=>({
      id:`draft-edge-${index+1}`,from:editorNodes[index].id,to:node.id,bidirectional:true,
      modes:["walking"],access:node.access||["visitor","employee","contractor","emergency"],approved:false
    }))).map(edge=>({kind:"hallway",accessible:true,...edge}));
  }catch{
    editorNodes=[];
    editorEdges=[];
  }
  editorActiveNodeId=null;
  editorHistory=[];
  rebuildEditorVisuals();
}

async function importEditorDraft(event){
  const file=event.target.files?.[0];
  event.target.value="";
  if(!file)return;
  try{
    const payload=JSON.parse(await file.text());
    if(payload.coordinate_system!=="PGS GLB model coordinates"||!Array.isArray(payload.nodes)||!Array.isArray(payload.edges)){
      throw new Error("unsupported pedestrian draft format");
    }
    pushEditorHistory();
    editorNodes=payload.nodes;
    editorEdges=payload.edges.map(edge=>({kind:"hallway",accessible:true,...edge}));
    editorActiveNodeId=null;
    rebuildEditorVisuals();
    document.getElementById("threeEditStatus").textContent=`Imported ${file.name} • ${editorNodes.length} nodes / ${editorEdges.length} walkways`;
  }catch(error){
    setStatus(`Could not import route draft: ${error.message}`,{error:true});
  }
}

function exportEditorDraft(){
  const blob=new Blob([JSON.stringify(editorPayload(),null,2)],{type:"application/json"});
  const link=document.createElement("a");
  link.href=URL.createObjectURL(blob);
  link.download=`pedestrian_network_map_${new Date().toISOString().slice(0,10)}.json`;
  link.click();
  setTimeout(()=>URL.revokeObjectURL(link.href),1000);
}

function labelOverridePayload(){
  return {
    schema_version:"0.1.0-draft",
    coordinate_system:"PGS GLB model coordinates",
    review_status:"draft_requires_site_approval",
    labels:labelOverrides
  };
}

function populateLabelTargets(selectedValue="new"){
  const select=document.getElementById("threeLabelTarget");
  const options=[...sourceLabelObjects.entries()].map(([id,label])=>({
    id,name:label.userData.displayName||id,group:label.userData.category||"building"
  }));
  labelOverrides.filter(item=>item.source_label_id?.startsWith("custom-label:")).forEach(item=>{
    options.push({id:item.source_label_id,name:item.name,group:item.kind||"area"});
  });
  select.innerHTML='<option value="new">New label</option>';
  options.sort((a,b)=>a.name.localeCompare(b.name)).forEach(item=>{
    const option=new Option(`${item.name} (${item.group})`,item.id);
    select.appendChild(option);
  });
  select.value=[...select.options].some(option=>option.value===selectedValue)?selectedValue:"new";
  selectLabelTarget();
  populateDestinationSources();
}

function selectLabelTarget(){
  const target=document.getElementById("threeLabelTarget").value;
  const override=labelOverrides.find(item=>item.source_label_id===target);
  const source=sourceLabelObjects.get(target);
  document.getElementById("threeLabelName").value=override?.name||source?.userData.displayName||"";
  document.getElementById("threeLabelKind").value=override?.kind||source?.userData.category||"building";
  document.getElementById("threeLabelRemove").disabled=target==="new"||!override;
}

function startLabelPlacement(){
  if(labelPlacementActive){cancelLabelPlacement();return;}
  const name=document.getElementById("threeLabelName").value.trim();
  if(!name){
    document.getElementById("threeLabelStatus").textContent="Enter a label name first";
    return;
  }
  if(editorActive)toggleRouteEditor();
  labelPlacementActive=true;
  controls.enabled=false;
  frame.classList.add("label-editing");
  document.getElementById("threeLabelPlace").classList.add("active");
  document.getElementById("threeLabelStatus").textContent="Click the exact feature in the 3D model";
  document.querySelector(".three-hint").textContent="Click the exact label anchor location";
}

function cancelLabelPlacement(){
  labelPlacementActive=false;
  controls.enabled=true;
  frame.classList.remove("label-editing");
  document.getElementById("threeLabelPlace").classList.remove("active");
  document.getElementById("threeLabelStatus").textContent="Label placement cancelled";
  document.querySelector(".three-hint").textContent="Drag to orbit • Scroll to zoom • Right-drag to pan";
}

function placeLabelOverride(local){
  const select=document.getElementById("threeLabelTarget");
  let target=select.value;
  if(target==="new")target=`custom-label:${Date.now()}`;
  const record={
    id:`label-override:${target}`,
    source_label_id:target,
    name:document.getElementById("threeLabelName").value.trim(),
    kind:document.getElementById("threeLabelKind").value,
    layer:activeEditorLayer(),
    position:{x:+local.x.toFixed(4),y:+(local.y+2).toFixed(4),z:+local.z.toFixed(4)},
    approved:false
  };
  const index=labelOverrides.findIndex(item=>item.source_label_id===target);
  if(index>=0)labelOverrides[index]=record; else labelOverrides.push(record);
  labelPlacementActive=false;
  controls.enabled=true;
  frame.classList.remove("label-editing");
  document.getElementById("threeLabelPlace").classList.remove("active");
  renderLabelOverrides();
  populateLabelTargets(target);
  persistLabelOverrides();
  document.getElementById("threeLabelStatus").textContent=`Placed ${record.name} • auto-saved locally`;
  document.querySelector(".three-hint").textContent="Drag to orbit • Scroll to zoom • Right-drag to pan";
}

function ensureLabelOverrideGroup(){
  if(labelOverrideGroup)return;
  labelOverrideGroup=new THREE.Group();
  labelOverrideGroup.name="PGS_AUTHORED_LABEL_OVERRIDES";
  model.add(labelOverrideGroup);
}

function renderLabelOverrides(){
  ensureLabelOverrideGroup();
  while(labelOverrideGroup.children.length){
    const child=labelOverrideGroup.children.pop();
    child.element?.remove?.();
  }
  sourceLabelObjects.forEach(label=>{label.userData.overridden=false;});
  labelOverrides.forEach(record=>{
    const source=sourceLabelObjects.get(record.source_label_id);
    if(source){source.userData.overridden=true;source.visible=false;}
    if(!record.position)return;
    const element=document.createElement("div");
    element.className="three-label three-authored-label";
    element.dataset.kind=record.kind;
    element.textContent=record.name;
    element.title=`Authored ${record.kind} label • ${record.approved?"approved":"draft"}`;
    const label=new CSS2DObject(element);
    label.position.set(record.position.x,record.position.y,record.position.z);
    label.userData={layer:record.layer||"ground",record};
    labelOverrideGroup.add(label);
  });
  buildingLabels.forEach(label=>{
    const layerToggle=document.querySelector(`[data-3d-layer="${label.userData.layer}"]`);
    label.visible=!label.userData.overridden&&Boolean(layerToggle?.checked);
  });
  labelOverrideGroup.children.forEach(label=>{
    const layerToggle=document.querySelector(`[data-3d-layer="${label.userData.layer}"]`);
    label.visible=Boolean(layerToggle?.checked);
  });
  updateSemanticLabelVisibility();
}

function saveLabelOverrides(){
  persistLabelOverrides();
  document.getElementById("threeLabelStatus").textContent=`Saved ${labelOverrides.length} label override${labelOverrides.length===1?"":"s"} locally`;
}

function persistLabelOverrides(){
  try{
    localStorage.setItem(LABEL_STORAGE_KEY,JSON.stringify(labelOverridePayload()));
  }catch(error){
    console.warn("Could not auto-save label overrides",error);
  }
}

function restoreLabelOverrides(){
  try{
    const saved=JSON.parse(localStorage.getItem(LABEL_STORAGE_KEY)||"null");
    labelOverrides=Array.isArray(saved?.labels)?saved.labels:[];
  }catch{labelOverrides=[];}
  renderLabelOverrides();
  populateLabelTargets();
}

function removeLabelOverride(){
  const target=document.getElementById("threeLabelTarget").value;
  labelOverrides=labelOverrides.filter(item=>item.source_label_id!==target);
  renderLabelOverrides();
  populateLabelTargets();
  persistLabelOverrides();
  document.getElementById("threeLabelStatus").textContent="Override removed; recovered label restored • auto-saved";
}

function exportLabelOverrides(){
  const blob=new Blob([JSON.stringify(labelOverridePayload(),null,2)],{type:"application/json"});
  const link=document.createElement("a");
  link.href=URL.createObjectURL(blob);
  link.download=`label_overrides_draft_${new Date().toISOString().slice(0,10)}.json`;
  link.click();
  setTimeout(()=>URL.revokeObjectURL(link.href),1000);
}

async function importLabelOverrides(event){
  const file=event.target.files?.[0];
  event.target.value="";
  if(!file)return;
  try{
    const payload=JSON.parse(await file.text());
    if(payload.coordinate_system!=="PGS GLB model coordinates"||!Array.isArray(payload.labels))throw new Error("unsupported label override format");
    labelOverrides=payload.labels;
    renderLabelOverrides();
    populateLabelTargets();
    persistLabelOverrides();
    document.getElementById("threeLabelStatus").textContent=`Imported ${file.name} • ${labelOverrides.length} labels • auto-saved`;
  }catch(error){
    setStatus(`Could not import label overrides: ${error.message}`,{error:true});
  }
}

function destinationPayload(){
  return {
    schema_version:"0.1.0-draft",
    coordinate_system:"PGS GLB model coordinates",
    authoring_mode:"destination_anchor_mapping",
    review_status:"draft_requires_site_approval",
    destinations:destinationDrafts
  };
}

function populateDestinationSources(selectedValue){
  const select=document.getElementById("threeDestinationSource");
  if(!select)return;
  const current=selectedValue??select.value;
  const choices=new Map();
  sourceLabelObjects.forEach((label,id)=>choices.set(id,{
    id,name:label.userData.displayName||id,kind:label.userData.category||"area"
  }));
  labelOverrides.forEach(record=>choices.set(record.source_label_id,{
    id:record.source_label_id,name:record.name,kind:record.kind||"area"
  }));
  select.innerHTML='<option value="">Select a mapped label</option>';
  [...choices.values()].sort((a,b)=>a.name.localeCompare(b.name)).forEach(item=>{
    select.appendChild(new Option(`${item.name} (${item.kind})`,item.id));
  });
  select.value=[...select.options].some(option=>option.value===current)?current:"";
  selectDestinationSource();
}

function selectDestinationSource(){
  const sourceId=document.getElementById("threeDestinationSource").value;
  const existing=destinationDrafts.find(item=>item.source_label_id===sourceId);
  const override=labelOverrides.find(item=>item.source_label_id===sourceId);
  const source=sourceLabelObjects.get(sourceId);
  document.getElementById("threeDestinationName").value=existing?.name||override?.name||source?.userData.displayName||"";
  if(existing){
    document.getElementById("threeDestinationCategory").value=existing.category||"department";
    document.getElementById("threeDestinationAccess").value=existing.access_profile||"employee";
  }
  document.getElementById("threeDestinationRemove").disabled=!existing;
  const statusText=existing
    ?`Anchored to ${existing.network_node_id||"no network node"} • ${existing.connector_distance?.toFixed?.(1)??"--"} units`
    :sourceId?"Place the pedestrian entrance, not the center of the room":"No destination anchor selected";
  document.getElementById("threeDestinationStatus").textContent=statusText;
}

function startDestinationPlacement(){
  if(destinationPlacementActive){cancelDestinationPlacement();return;}
  const sourceId=document.getElementById("threeDestinationSource").value;
  const name=document.getElementById("threeDestinationName").value.trim();
  if(!sourceId||!name){
    document.getElementById("threeDestinationStatus").textContent="Choose a mapped label and destination name first";
    return;
  }
  if(editorActive)toggleRouteEditor();
  if(labelPlacementActive)cancelLabelPlacement();
  destinationPlacementActive=true;
  controls.enabled=false;
  frame.classList.add("label-editing");
  document.getElementById("threeDestinationPlace").classList.add("active");
  document.getElementById("threeDestinationStatus").textContent="Click the pedestrian entrance or arrival point";
  document.querySelector(".three-hint").textContent="Click the exact pedestrian arrival point for this destination";
}

function cancelDestinationPlacement(){
  destinationPlacementActive=false;
  controls.enabled=true;
  frame.classList.remove("label-editing");
  document.getElementById("threeDestinationPlace").classList.remove("active");
  document.getElementById("threeDestinationStatus").textContent="Destination placement cancelled";
  document.querySelector(".three-hint").textContent="Drag to orbit • Scroll to zoom • Right-drag to pan";
}

function nearestEditorNode(position){
  let nearest=null;
  editorNodes.forEach(node=>{
    const distance=Math.hypot(
      position.x-node.position.x,
      position.y-node.position.y,
      position.z-node.position.z
    );
    if(!nearest||distance<nearest.distance)nearest={node,distance};
  });
  return nearest;
}

function placeDestinationDraft(local){
  const sourceId=document.getElementById("threeDestinationSource").value;
  const position={x:+local.x.toFixed(4),y:+(local.y+.5).toFixed(4),z:+local.z.toFixed(4)};
  const nearest=nearestEditorNode(position);
  const record={
    id:`destination-draft:${sourceId}`,
    source_label_id:sourceId,
    name:document.getElementById("threeDestinationName").value.trim(),
    category:document.getElementById("threeDestinationCategory").value,
    access_profile:document.getElementById("threeDestinationAccess").value,
    layer:activeEditorLayer(),
    position,
    network_node_id:nearest?.node.id||null,
    connector_distance:nearest?+nearest.distance.toFixed(4):null,
    approved:false
  };
  const index=destinationDrafts.findIndex(item=>item.source_label_id===sourceId);
  if(index>=0)destinationDrafts[index]=record;else destinationDrafts.push(record);
  destinationPlacementActive=false;
  controls.enabled=true;
  frame.classList.remove("label-editing");
  document.getElementById("threeDestinationPlace").classList.remove("active");
  renderDestinationDrafts();
  persistDestinationDrafts();
  populateDestinationSources(sourceId);
  document.getElementById("threeDestinationStatus").textContent=nearest
    ?`Auto-saved • nearest network node ${nearest.node.id.replace("draft-node-","")} is ${nearest.distance.toFixed(1)} units away`
    :"Auto-saved • map a nearby pedestrian walkway before approval";
  document.querySelector(".three-hint").textContent="Drag to orbit • Scroll to zoom • Right-drag to pan";
}

function ensureDestinationDraftGroup(){
  if(destinationDraftGroup)return;
  destinationDraftGroup=new THREE.Group();
  destinationDraftGroup.name="PGS_DESTINATION_ANCHOR_DRAFTS";
  model.add(destinationDraftGroup);
}

function renderDestinationDrafts(){
  ensureDestinationDraftGroup();
  while(destinationDraftGroup.children.length){
    const child=destinationDraftGroup.children.pop();
    child.traverse(descendant=>descendant.element?.remove?.());
    disposeObject(child);
  }
  const nodes=new Map(editorNodes.map(node=>[node.id,node]));
  destinationDrafts.forEach(record=>{
    if(!record.position)return;
    const position=new THREE.Vector3(record.position.x,record.position.y,record.position.z);
    const anchor=marker(position,0x38d8ff,2.5);
    anchor.className="three-destination-marker";
    const element=document.createElement("div");
    element.className="three-label three-destination-label";
    element.textContent=record.name;
    const label=new CSS2DObject(element);
    label.position.set(0,5,0);
    anchor.add(label);
    destinationDraftGroup.add(anchor);
    const target=nodes.get(record.network_node_id);
    if(target){
      const line=new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([position,new THREE.Vector3(target.position.x,target.position.y,target.position.z)]),
        new THREE.LineDashedMaterial({color:0x38d8ff,dashSize:3,gapSize:2})
      );
      line.computeLineDistances();
      destinationDraftGroup.add(line);
    }
  });
  document.getElementById("threeDestinationExport").disabled=destinationDrafts.length===0;
}

function persistDestinationDrafts(){
  try{localStorage.setItem(DESTINATION_STORAGE_KEY,JSON.stringify(destinationPayload()));}
  catch(error){console.warn("Could not auto-save destination anchors",error);}
}

function restoreDestinationDrafts(){
  try{
    const saved=JSON.parse(localStorage.getItem(DESTINATION_STORAGE_KEY)||"null");
    destinationDrafts=Array.isArray(saved?.destinations)?saved.destinations:[];
  }catch{destinationDrafts=[];}
  renderDestinationDrafts();
  populateDestinationSources();
}

function removeDestinationDraft(){
  const sourceId=document.getElementById("threeDestinationSource").value;
  destinationDrafts=destinationDrafts.filter(item=>item.source_label_id!==sourceId);
  renderDestinationDrafts();
  persistDestinationDrafts();
  populateDestinationSources(sourceId);
}

function exportDestinationDrafts(){
  const blob=new Blob([JSON.stringify(destinationPayload(),null,2)],{type:"application/json"});
  const link=document.createElement("a");
  link.href=URL.createObjectURL(blob);
  link.download=`destination_anchors_draft_${new Date().toISOString().slice(0,10)}.json`;
  link.click();
  setTimeout(()=>URL.revokeObjectURL(link.href),1000);
}

async function importDestinationDrafts(event){
  const file=event.target.files?.[0];
  event.target.value="";
  if(!file)return;
  try{
    const payload=JSON.parse(await file.text());
    if(payload.coordinate_system!=="PGS GLB model coordinates"||!Array.isArray(payload.destinations))throw new Error("unsupported destination anchor format");
    destinationDrafts=payload.destinations;
    renderDestinationDrafts();
    persistDestinationDrafts();
    populateDestinationSources();
    document.getElementById("threeDestinationStatus").textContent=`Imported ${file.name} • ${destinationDrafts.length} destination anchors • auto-saved`;
  }catch(error){
    setStatus(`Could not import destination anchors: ${error.message}`,{error:true});
  }
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
