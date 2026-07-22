import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";

// ... (Keep all your existing variables from the top of the file here)
const host = document.getElementById("threeCanvas");
const frame = document.getElementById("threeFrame");
const status = document.getElementById("threeStatus");
// ...

function initialize() {
    if (initialized) return;
    initialized = true;
    // ... (Keep all your existing THREE.js setup code here)

    // SAFE LISTENERS: Use arrow functions () => func() so the browser
    // finds the function at runtime, not at initialization.
    const listeners = [
        { id: "threeWalkwaysToggle", event: "change", fn: (e) => { if(editorGroup) editorGroup.visible = e.target.checked; } },
        { id: "threeRouteToggle", event: "change", fn: (e) => { if(routeGroup) routeGroup.visible = e.target.checked; } },
        { id: "threeWalkToggle", event: "click", fn: () => toggleWalkPreview() },
        { id: "threeEditToggle", event: "click", fn: () => toggleRouteEditor() },
        { id: "threeEditUndo", event: "click", fn: () => undoEditorNode() },
        { id: "threeEditSegment", event: "click", fn: () => startEditorSegment() },
        { id: "threeEditDelete", event: "click", fn: () => deleteSelectedEditorNode() },
        { id: "threeEditClear", event: "click", fn: () => clearEditorDraft() },
        { id: "threeEditSave", event: "click", fn: () => saveEditorDraft() },
        { id: "threeEditExport", event: "click", fn: () => exportEditorDraft() },
        { id: "threeLabelTarget", event: "change", fn: () => selectLabelTarget() },
        { id: "threeLabelPlace", event: "click", fn: () => startLabelPlacement() },
        { id: "threeLabelRemove", event: "click", fn: () => removeLabelOverride() },
        { id: "threeLabelSave", event: "click", fn: () => saveLabelOverrides() },
        { id: "threeLabelExport", event: "click", fn: () => exportLabelOverrides() },
        { id: "threeDestinationSource", event: "change", fn: () => selectDestinationSource() },
        { id: "threeDestinationPlace", event: "click", fn: () => startDestinationPlacement() },
        { id: "threeDestinationRemove", event: "click", fn: () => removeDestinationDraft() },
        { id: "threeDestinationExport", event: "click", fn: () => exportDestinationDrafts() }
    ];

    listeners.forEach(l => {
        const el = document.getElementById(l.id);
        if (el) el.addEventListener(l.event, l.fn);
    });

    // ... (Keep the rest of your initialize code: renderer, pointer events, etc.)
}

// ... (Keep all your functions like toggleWalkPreview, toggleRouteEditor, etc. below this)