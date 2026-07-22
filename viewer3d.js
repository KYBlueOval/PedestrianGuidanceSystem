import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";

const host = document.getElementById("threeCanvas");
const frame = document.getElementById("threeFrame");
const status = document.getElementById("threeStatus");
let renderer, labelRenderer, scene, camera, controls, model, resizeObserver;
let initialized = false, loading = false, visible = false;
const layerObjects = { site: [], ground: [], mezzanine: [], roof: [] };
const buildingLabels = [];
const semanticLabels = [];
const sourceLabelObjects = new Map();
const floorLayerIndex = new Map();
let spatialOverrides = {}, routeGroup, routeCurve, tracker;
let routeProgress = 0, trackingPaused = false, routeDuration = 24, lastFrameTime = performance.now();
let editorActive = false, editorGroup;
let editorNodes = [], editorEdges = [], editorActiveNodeId = null, editorHistory = [];
let labelOverrides = [], labelOverrideGroup, labelPlacementActive = false;
let destinationDrafts = [], destinationDraftGroup, destinationPlacementActive = false;
let pointerStart = null;
let animationFrameCount = 0;
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const EDITOR_STORAGE_KEY = "pgs-v10-pedestrian-network-draft";
const LABEL_STORAGE_KEY = "pgs-v10-label-overrides-draft";
const DESTINATION_STORAGE_KEY = "pgs-v10-destination-anchors-draft";

function setStatus(message, { error = false, hidden = false } = {}) {
    status.classList.toggle("error", error);
    status.classList.toggle("is-hidden", hidden);
    status.querySelector("span:last-child").textContent = message;
}

// Declare all referenced toggle/event functions FIRST so they are in scope
function toggleWalkPreview(){
  if(!tracker)return;
  trackingPaused=!trackingPaused;
  const btn = document.getElementById("threeWalkToggle");
  if(btn) btn.textContent = trackingPaused ? "Resume Walk Preview" : "Pause Walk Preview";
}

function toggleRouteEditor(){
  if(!model)return;
  if(labelPlacementActive) cancelLabelPlacement();
  if(destinationPlacementActive) cancelDestinationPlacement();
  editorActive=!editorActive;
  if(editorActive){
    const tw = document.getElementById("threeWalkwaysToggle");
    if(tw) tw.checked = true;
    if(editorGroup) editorGroup.visible = true;
  }
  controls.enabled = !editorActive;
  frame.classList.toggle("route-editing", editorActive);
  const button = document.getElementById("threeEditToggle");
  if(button) {
      button.classList.toggle("active", editorActive);
      button.textContent = editorActive ? "Finish Mapping" : "Start Mapping";
  }
  rebuildEditorVisuals();
}

function undoEditorNode(){ undoEditorAction(); }
function startEditorSegment(){ editorActiveNodeId = null; rebuildEditorVisuals(); }
function deleteSelectedEditorNode(){ deleteSelectedNode(); }
function clearEditorDraft(){ clearDraftNetwork(); }
function saveEditorDraft(){ persistEditorDraft(); }
function exportEditorDraft(){ exportNetworkDraft(); }

// Placeholder safe triggers for custom functions if names vary
function undoEditorAction() {
  const previous = editorHistory.pop();
  if(!previous)return;
  const state = JSON.parse(previous);
  editorNodes = state.nodes || [];
  editorEdges = state.edges || [];
  editorActiveNodeId = state.active || null;
  rebuildEditorVisuals();
}

function deleteSelectedNode() {
  if(!editorActiveNodeId)return;
  pushEditorHistory();
  editorNodes = editorNodes.filter(node => node.id !== editorActiveNodeId);
  editorEdges = editorEdges.filter(edge => edge.from !== editorActiveNodeId && edge.to !== editorActiveNodeId);
  editorActiveNodeId = null;
  rebuildEditorVisuals();
}

function clearDraftNetwork() {
  pushEditorHistory();
  editorNodes = [];
  editorEdges = [];
  editorActiveNodeId = null;
  localStorage.removeItem(EDITOR_STORAGE_KEY);
  rebuildEditorVisuals();
}

function exportNetworkDraft() {
  const blob = new Blob([JSON.stringify(editorPayload(), null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `pedestrian_network_map_${new Date().toISOString().slice(0,10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function selectLabelTarget(){ selectTargetLabel(); }
function selectTargetLabel() {
  const target = document.getElementById("threeLabelTarget")?.value;
  const override = labelOverrides.find(item => item.source_label_id === target);
  const source = sourceLabelObjects.get(target);
  const nameEl = document.getElementById("threeLabelName");
  const kindEl = document.getElementById("threeLabelKind");
  const remEl = document.getElementById("threeLabelRemove");
  if(nameEl) nameEl.value = override?.name || source?.userData.displayName || "";
  if(kindEl) kindEl.value = override?.kind || source?.userData.category || "building";
  if(remEl) remEl.disabled = target === "new" || !override;
}

function startLabelPlacement(){ beginLabelPlacement(); }
function beginLabelPlacement() {
  if(labelPlacementActive){ cancelLabelPlacement(); return; }
  const name = document.getElementById("threeLabelName")?.value.trim();
  if(!name){
    const st = document.getElementById("threeLabelStatus");
    if(st) st.textContent = "Enter a label name first";
    return;
  }
  if(editorActive) toggleRouteEditor();
  labelPlacementActive = true;
  controls.enabled = false;
  frame.classList.add("label-editing");
  const pl = document.getElementById("threeLabelPlace");
  if(pl) pl.classList.add("active");
}

function cancelLabelPlacement(){
  labelPlacementActive = false;
  controls.enabled = true;
  frame.classList.remove("label-editing");
  const pl = document.getElementById("threeLabelPlace");
  if(pl) pl.classList.remove("active");
}

function removeLabelOverride(){
  const target = document.getElementById("threeLabelTarget")?.value;
  labelOverrides = labelOverrides.filter(item => item.source_label_id !== target);
  renderLabelOverrides();
  populateLabelTargets();
  persistLabelOverrides();
}

function selectDestinationSource(){ selectDestSource(); }
function selectDestSource() {
  const sourceId = document.getElementById("threeDestinationSource")?.value;
  const existing = destinationDrafts.find(item => item.source_label_id === sourceId);
  const override = labelOverrides.find(item => item.source_label_id === sourceId);
  const source = sourceLabelObjects.get(sourceId);
  const nameEl = document.getElementById("threeDestinationName");
  const remEl = document.getElementById("threeDestinationRemove");
  if(nameEl) nameEl.value = existing?.name || override?.name || source?.userData.displayName || "";
  if(remEl) remEl.disabled = !existing;
}

function startDestinationPlacement(){ beginDestinationPlacement(); }
function beginDestinationPlacement() {
  if(destinationPlacementActive){ cancelDestinationPlacement(); return; }
  const sourceId = document.getElementById("threeDestinationSource")?.value;
  const name = document.getElementById("threeDestinationName")?.value.trim();
  if(!sourceId || !name) return;
  if(editorActive) toggleRouteEditor();
  if(labelPlacementActive) cancelLabelPlacement();
  destinationPlacementActive = true;
  controls.enabled = false;
  frame.classList.add("label-editing");
  const dp = document.getElementById("threeDestinationPlace");
  if(dp) dp.classList.add("active");
}

function cancelDestinationPlacement(){
  destinationPlacementActive = false;
  controls.enabled = true;
  frame.classList.remove("label-editing");
  const dp = document.getElementById("threeDestinationPlace");
  if(dp) dp.classList.remove("active");
}

function removeDestinationDraft(){
  const sourceId = document.getElementById("threeDestinationSource")?.value;
  destinationDrafts = destinationDrafts.filter(item => item.source_label_id !== sourceId);
  renderDestinationDrafts();
  persistDestinationDrafts();
  populateDestinationSources(sourceId);
}

function exportDestinationDrafts(){
  const blob = new Blob([JSON.stringify(destinationPayload(), null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `destination_anchors_draft_${new Date().toISOString().slice(0,10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function importDestinationDrafts(event){
  const file = event.target.files?.[0];
  event.target.value = "";
  if(!file) return;
  file.text().then(text => {
    try {
      const payload = JSON.parse(text);
      if(payload.coordinate_system !== "PGS GLB model coordinates" || !Array.isArray(payload.destinations)) throw new Error("format");
      destinationDrafts = payload.destinations;
      renderDestinationDrafts();
      persistDestinationDrafts();
      populateDestinationSources();
    } catch(e) { console.error(e); }
  });
}

function importLabelOverrides(event){
  const file = event.target.files?.[0];
  event.target.value = "";
  if(!file) return;
  file.text().then(text => {
    try {
      const payload = JSON.parse(text);
      labelOverrides = payload.labels || [];
      renderLabelOverrides();
      populateLabelTargets();
      persistLabelOverrides();
    } catch(e) { console.error(e); }
  });
}

function importEditorDraft(event){
  const file = event.target.files?.[0];
  event.target.value = "";
  if(!file) return;
  file.text().then(text => {
    try {
      const payload = JSON.parse(text);
      editorNodes = payload.nodes || [];
      editorEdges = payload.edges || [];
      rebuildEditorVisuals();
    } catch(e) { console.error(e); }
  });
}

function handleEditorPointerUp(event){
  if((!editorActive && !labelPlacementActive && !destinationPlacementActive) || event.button !== 0 || !pointerStart) return;
  const movement = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
  pointerStart = null;
  if(movement > 5) return;
}

function rebuildEditorVisuals() {}
function pushEditorHistory() {}
function destinationPayload() { return { destinations: destinationDrafts }; }
function renderDestinationDrafts() {}
function persistDestinationDrafts() {}
function populateDestinationSources() {}
function renderLabelOverrides() {}
function populateLabelTargets() {}
function persistLabelOverrides() {}
function activeEditorLayer() { return "ground"; }

function initialize() {
    if (initialized) return;
    initialized = true;
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x071629);
    scene.fog = new THREE.Fog(0x071629, 900, 2800);

    camera = new THREE.PerspectiveCamera(45, 1, .1, 10000);
    camera.position.set(500, 420, 500);

    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(Math.max(host.clientWidth, 1), Math.max(host.clientHeight, 1), false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);

    labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(Math.max(host.clientWidth, 1), Math.max(host.clientHeight, 1));
    labelRenderer.domElement.className = "three-label-layer";
    host.appendChild(labelRenderer.domElement);

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = .08;
    controls.screenSpacePanning = true;
    controls.maxPolarAngle = Math.PI * .49;

    scene.add(new THREE.HemisphereLight(0xdceeff, 0x19334d, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.6);
    sun.position.set(300, 600, 250);
    scene.add(sun);
    const grid = new THREE.GridHelper(2400, 48, 0x225a83, 0x15344d);
    grid.material.opacity = .28;
    grid.material.transparent = true;
    scene.add(grid);

    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(frame);

    const listeners = [
        { id: "threeWalkwaysToggle", event: "change", fn: (e) => { if (editorGroup) editorGroup.visible = e.target.checked; } },
        { id: "threeRouteToggle", event: "change", fn: (e) => { if (routeGroup) routeGroup.visible = e.target.checked; } },
        { id: "threeWalkToggle", event: "click", fn: toggleWalkPreview },
        { id: "threeEditToggle", event: "click", fn: toggleRouteEditor },
        { id: "threeEditUndo", event: "click", fn: undoEditorNode },
        { id: "threeEditSegment", event: "click", fn: startEditorSegment },
        { id: "threeEditDelete", event: "click", fn: deleteSelectedEditorNode },
        { id: "threeEditClear", event: "click", fn: clearEditorDraft },
        { id: "threeEditSave", event: "click", fn: saveEditorDraft },
        { id: "threeEditExport", event: "click", fn: exportEditorDraft },
        { id: "threeEditImport", event: "click", fn: () => document.getElementById("threeEditImportFile")?.click() },
        { id: "threeEditImportFile", event: "change", fn: importEditorDraft },
        { id: "threeLabelTarget", event: "change", fn: selectLabelTarget },
        { id: "threeLabelPlace", event: "click", fn: startLabelPlacement },
        { id: "threeLabelRemove", event: "click", fn: removeLabelOverride },
        { id: "threeLabelSave", event: "click", fn: saveLabelOverrides },
        { id: "threeLabelExport", event: "click", fn: exportLabelOverrides },
        { id: "threeLabelImport", event: "click", fn: () => document.getElementById("threeLabelImportFile")?.click() },
        { id: "threeLabelImportFile", event: "change", fn: importLabelOverrides },
        { id: "threeDestinationSource", event: "change", fn: selectDestinationSource },
        { id: "threeDestinationPlace", event: "click", fn: startDestinationPlacement },
        { id: "threeDestinationRemove", event: "click", fn: removeDestinationDraft },
        { id: "threeDestinationExport", event: "click", fn: exportDestinationDrafts },
        { id: "threeDestinationImport", event: "click", fn: () => document.getElementById("threeDestinationImportFile")?.click() },
        { id: "threeDestinationImportFile", event: "change", fn: importDestinationDrafts }
    ];

    listeners.forEach(l => {
        const el = document.getElementById(l.id);
        if (el) el.addEventListener(l.event, l.fn);
    });

    renderer.domElement.addEventListener("pointerdown", event => { pointerStart = { x: event.clientX, y: event.clientY }; });
    renderer.domElement.addEventListener("pointerup", handleEditorPointerUp);
    window.addEventListener("pgs:route", event => renderRoute(event.detail));
    animate();
}

async function loadModel() {
    if (model) return;
    if (loading) return;
    loading = true;
    setStatus("Preparing 3D twin…");
    try {
        const config = await fetch("data/config.json", { cache: "no-store" }).then(r => r.json());
        const modelUrl = config.views?.model || "assets/models/site_mobile.glb";
        const loader = new GLTFLoader();
        const gltf = await loader.loadAsync(modelUrl);
        model = gltf.scene;
        scene.add(model);
        fitModel();
        setStatus("3D twin ready", { hidden: true });
    } catch (e) {
        console.error("PGS 3D Load Error:", e);
        setStatus("Load Error: " + e.message, { error: true });
    } finally {
        loading = false;
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

window.pgs3d = { show, hide, reset };