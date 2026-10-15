// ---------------------------------------------------------------------------
// renderer.js — everything Three.js: the map, sky, lights and the camera.
// The 3D world uses Hammer coordinates directly (Z is up), so positions from
// the physics code can be used as-is.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Make Three.js treat +Z as "up" like Hammer/Source.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

// CS2 uses a 90° horizontal FOV at 4:3, i.e. ~73.74° vertical, kept the same
// on widescreen (so 16:9 shows more at the sides, like in CS2).
export const BASE_VFOV = 2 * Math.atan(Math.tan((90 * Math.PI) / 360) * 0.75) * (180 / Math.PI);

export class Renderer {
  constructor(canvas, settings) {
    this.settings = settings;
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = !!settings.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.autoClear = false;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0xc9d6e0, 3000, 14000);
    this.camera = new THREE.PerspectiveCamera(BASE_VFOV, 1, 2, 30000);
    this.camera.up.set(0, 0, 1);

    // Separate scene for the first-person weapon so it never clips into walls.
    this.viewScene = new THREE.Scene();
    this.viewCamera = new THREE.PerspectiveCamera(settings.viewmodelFov, 1, 0.5, 200);
    this.viewCamera.up.set(0, 0, 1);

    this.fovScale = 1;
    this.makeSky();
    this.makeLights();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  makeSky() {
    const geo = new THREE.SphereGeometry(20000, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x3d6fb0) },
        horizon: { value: new THREE.Color(0xd8e4ec) },
        bottom: { value: new THREE.Color(0xc2b090) },
      },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; varying vec3 vDir;
        void main(){ float h = vDir.z; vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.55)) : mix(horizon, bottom, pow(-h, 0.4));
        gl_FragColor = vec4(c, 1.0); }`,
    });
    this.sky = new THREE.Mesh(geo, mat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1;
    this.scene.add(this.sky);
  }

  makeLights() {
    const hemi = new THREE.HemisphereLight(0xdfeaff, 0x8a7350, 1.35);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff1d6, 2.4);
    sun.position.set(1800, -1200, 3200);
    sun.target.position.set(-300, 1100, 0);
    sun.castShadow = !!this.settings.shadows;
    sun.shadow.mapSize.set(4096, 4096);
    const cam = sun.shadow.camera;
    cam.left = -3600; cam.right = 3600; cam.top = 3600; cam.bottom = -3600;
    cam.near = 100; cam.far = 9000;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 1.5;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;
    // the weapon gets its own simple lighting
    this.viewScene.add(new THREE.HemisphereLight(0xffffff, 0x665544, 2.2));
    const vsun = new THREE.DirectionalLight(0xffffff, 1.6);
    vsun.position.set(1, -1, 2);
    this.viewScene.add(vsun);
  }

  resize() {
    const scale = Math.max(0.25, Math.min(2, this.settings.renderScale || 1));
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2) * scale);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.viewCamera.aspect = w / h;
    this.updateFov();
  }

  updateFov() {
    // fovScale < 1 when scoped in (e.g. AWP)
    const v = 2 * Math.atan(Math.tan((BASE_VFOV * Math.PI) / 360) * this.fovScale) * (180 / Math.PI);
    this.camera.fov = v;
    this.camera.updateProjectionMatrix();
    // CS2's viewmodel_fov (68) is a horizontal angle at 4:3 -> convert to vertical
    this.viewCamera.fov = 2 * Math.atan(Math.tan((this.settings.viewmodelFov * Math.PI) / 360) * 0.75) * (180 / Math.PI);
    this.viewCamera.updateProjectionMatrix();
  }

  setFovScale(s) {
    if (Math.abs(s - this.fovScale) < 1e-4) return;
    this.fovScale = s;
    this.updateFov();
  }

  /**
   * Draw the map from the .glb using the axis/scale decided by mapLoader.js
   * (so what you SEE matches what you COLLIDE with).
   */
  async loadMap(arrayBuffer, geo) {
    const loader = new GLTFLoader();
    const gltf = await new Promise((resolve, reject) => loader.parse(arrayBuffer, '', resolve, reject));
    const assoc = gltf.parser.associations;
    const hidden = new Set(geo.hidden.map((h) => h.nodeIndex + ':' + h.primitiveIndex));
    const ignored = new Set(geo.ignoredNodeIndices);
    const toHide = [];
    gltf.scene.traverse((obj) => {
      const a = assoc.get(obj);
      if (a && a.nodes !== undefined && ignored.has(a.nodes)) {
        obj.position.set(0, 0, 0);
        obj.quaternion.identity();
        obj.scale.set(1, 1, 1);
      }
      if (obj.isMesh) {
        let nodeIndex = a && a.nodes !== undefined ? a.nodes : undefined;
        if (nodeIndex === undefined && obj.parent) {
          const pa = assoc.get(obj.parent);
          if (pa && pa.nodes !== undefined) nodeIndex = pa.nodes;
        }
        const prim = a && a.primitives !== undefined ? a.primitives : 0;
        if (nodeIndex !== undefined && hidden.has(nodeIndex + ':' + prim)) toHide.push(obj);
        obj.castShadow = true;
        obj.receiveShadow = true;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (m.map) {
            m.map.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
          }
          // These materials come from an old engine: no metal, fairly rough.
          if ('metalness' in m) m.metalness = 0;
          if ('roughness' in m) m.roughness = 0.92;
        }
      }
    });
    for (const o of toHide) o.visible = false;
    const root = new THREE.Group();
    root.name = 'map';
    root.matrixAutoUpdate = false;
    root.matrix.fromArray(geo.basis);
    root.add(gltf.scene);
    root.updateMatrixWorld(true);
    this.scene.add(root);
    this.mapRoot = root;
    return root;
  }

  /** Point the camera from `eye` using Source angles (degrees). */
  setView(eye, yaw, pitch, roll = 0) {
    const y = (yaw * Math.PI) / 180, p = (pitch * Math.PI) / 180;
    const fx = Math.cos(p) * Math.cos(y), fy = Math.cos(p) * Math.sin(y), fz = -Math.sin(p);
    this.camera.position.set(eye[0], eye[1], eye[2]);
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(eye[0] + fx, eye[1] + fy, eye[2] + fz);
    if (roll) this.camera.rotateZ((roll * Math.PI) / 180);
    this.sky.position.copy(this.camera.position);
  }

  render() {
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    if (this.viewScene.children.length > 2) {
      this.renderer.clearDepth();
      this.renderer.render(this.viewScene, this.viewCamera);
    }
  }
}

export { THREE };
