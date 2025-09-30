import "./style.css";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PI } from "three/tsl";
//import SimplexNoise from "simplex-noise";
import { createNoise4D } from "simplex-noise";

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xcecbcc); // Set background to grey
const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// Create globe
const geometry = new THREE.SphereGeometry(2, 64, 64);
const material = new THREE.MeshStandardMaterial({
  color: 0xda1284,
  wireframe: false,
  roughness: 0.5, // Lower roughness for shinier metallic look
  metalness: 0.8, // Fully metallic
});
const globe = new THREE.Mesh(geometry, material);
scene.add(globe);

// Lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.9);
scene.add(ambientLight);
// const directionalLight = new THREE.DirectionalLight(0xffffff, 0.7);
// directionalLight.position.set(5, 5, 5);
// scene.add(directionalLight);

// Fill light (soft white, from camera direction)
const fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
scene.add(fillLight);
fillLight.target.position.copy(globe.position);
scene.add(fillLight.target);

// Rim light (cool color, from behind camera direction)
const rimLight = new THREE.DirectionalLight(0x99ccff, 0.7);
scene.add(rimLight);
rimLight.target.position.copy(globe.position);
scene.add(rimLight.target);

// Camera position
camera.position.z = 6;

// Orbit controls
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;

// Raycaster for click detection
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

let lastPointerPosition = null;
let activeArc = null;
let activePointer = null;
let activeExtrude = null; // Track the latest extruded mesh
const extrudedRibbons = []; // Store all extruded ribbons

// Store all arc/ribbon data for animation
const animatedRibbons = [];

// --- Add Simplex Noise for 4D noise field ---
// const simplex = new SimplexNoise();
const noise4D = new createNoise4D();

// Utility: apply 4D noise to a point along the arc
function applyNoiseToPoint(
  point,
  t,
  arcId = 0,
  scale = 0.5,
  freq = 1.5,
  time = 0
) {
  // t: 0..1 along the arc, arcId: unique per arc, time: animation or static
  // Use position, t, arcId, and time as 4D input
  // const n = simplex.noise4D(
  const n = noise4D(
    point.x * freq,
    point.y * freq,
    point.z * freq,
    t * 2 + arcId * 10 + time
  );
  // Displace along the normal from globe center
  const globeCenter = globe.position;
  const normal = point.clone().sub(globeCenter).normalize();
  return point.clone().add(normal.multiplyScalar(n * scale));
}

// Utility: create arc points between three vectors using the unique circle through three points
function createArcPoints(start, center, end, resolution = 64) {
  // Find the unique circle passing through start, center, end
  // All points are Vector3
  // 1. Find the plane normal
  const v1 = start.clone();
  const v2 = center.clone();
  const v3 = end.clone();

  const a = v2.clone().sub(v1);
  const b = v3.clone().sub(v1);
  const planeNormal = a.clone().cross(b).normalize();

  // 2. Find the circle center
  // Algorithm: https://math.stackexchange.com/a/1460095
  const midAB = v1.clone().add(v2).multiplyScalar(0.5);
  const midBC = v2.clone().add(v3).multiplyScalar(0.5);

  const ab = v2.clone().sub(v1);
  const bc = v3.clone().sub(v2);

  const abNorm = ab.clone().cross(planeNormal).normalize();
  const bcNorm = bc.clone().cross(planeNormal).normalize();

  // Solve for intersection of two lines: midAB + s*abNorm and midBC + t*bcNorm
  // We solve for s and t such that:
  // midAB + s*abNorm = midBC + t*bcNorm
  // Rearranged: s*abNorm - t*bcNorm = midBC - midAB

  // Build system: [abNorm, -bcNorm] * [s; t] = midBC - midAB
  // We'll solve using least squares
  const M = new THREE.Matrix3();
  M.set(abNorm.x, -bcNorm.x, 0, abNorm.y, -bcNorm.y, 0, abNorm.z, -bcNorm.z, 0);
  const rhs = midBC.clone().sub(midAB);

  // Only need two equations (since lines are coplanar), so use x and y
  // [abNorm.x, -bcNorm.x][s;t] = rhs.x
  // [abNorm.y, -bcNorm.y][s;t] = rhs.y
  // Solve for s and t
  const det = abNorm.x * -bcNorm.y - abNorm.y * -bcNorm.x;
  let s = 0,
    t = 0;
  if (Math.abs(det) > 1e-8) {
    s = (rhs.x * -bcNorm.y - rhs.y * -bcNorm.x) / det;
    t = (abNorm.x * rhs.y - abNorm.y * rhs.x) / det;
  }
  const circleCenter = midAB.clone().add(abNorm.clone().multiplyScalar(s));

  // 3. Radius
  const radius = circleCenter.distanceTo(v1);

  // 4. Parametrize the arc
  // Get start and end vectors from center
  const from = v1.clone().sub(circleCenter).normalize();
  const mid = v2.clone().sub(circleCenter).normalize();
  const to = v3.clone().sub(circleCenter).normalize();

  // Find angles
  let angleStart = 0;
  let angleMid = Math.acos(THREE.MathUtils.clamp(from.dot(mid), -1, 1));
  let angleEnd = Math.acos(THREE.MathUtils.clamp(from.dot(to), -1, 1));

  // Determine direction (sign) using plane normal
  const crossMid = from.clone().cross(mid).dot(planeNormal);
  if (crossMid < 0) angleMid = -angleMid;
  const crossEnd = from.clone().cross(to).dot(planeNormal);
  if (crossEnd < 0) angleEnd = -angleEnd;

  // Ensure angleEnd covers the arc passing through mid
  if (angleMid > angleEnd) {
    if (angleMid > 0) angleEnd += 2 * Math.PI;
    else angleEnd -= 2 * Math.PI;
  }

  // 5. Generate points along the arc
  const points = [];
  for (let i = 0; i <= resolution; i++) {
    const t = i / resolution;
    const theta = angleStart + (angleEnd - angleStart) * t;
    // Rodrigues' rotation formula
    const axis = planeNormal;
    const vec = from.clone().applyAxisAngle(axis, theta).multiplyScalar(radius);
    points.push(circleCenter.clone().add(vec));
  }
  return points;
}

// Utility: project a point to the nearest point on the globe surface, then offset outward
function projectToGlobeSurface(point, globeCenter, globeRadius, offset = 0.2) {
  const dir = point.clone().sub(globeCenter).normalize();
  return globeCenter.clone().add(dir.multiplyScalar(globeRadius + offset));
}

// Animate arc drawing between two points on the globe
function animateRibbon(prev, curr) {
  if (activeArc) {
    scene.remove(activeArc);
    if (activeArc.geometry) activeArc.geometry.dispose();
    if (activeArc.material) activeArc.material.dispose();
    activeArc = null;
  }
  if (activeExtrude) {
    scene.remove(activeExtrude);
    if (activeExtrude.geometry) activeExtrude.geometry.dispose();
    if (activeExtrude.material) activeExtrude.material.dispose();
    activeExtrude = null;
  }
  // Find midpoint and project to globe surface, then offset outward
  const midpoint = prev.clone().add(curr).multiplyScalar(0.5);
  const globeCenter = globe.position;
  const globeRadius = geometry.parameters.radius;
  const arcMid = projectToGlobeSurface(midpoint, globeCenter, globeRadius, 0.3);

  // Store the base arc points and extrusion data for animation
  const arcPointsBase = createArcPoints(prev, arcMid, curr, 64);
  const ribbonWidth = 0.08;
  const arcId = Date.now() % 100000;

  // Animation state for this ribbon
  const ribbonAnim = {
    arcPointsBase,
    ribbonWidth,
    arcId,
    mesh: null,
    drawIndex: 2, // Start animating from 2 points
    animating: true,
  };

  animatedRibbons.push(ribbonAnim);
}

// Update all animated ribbons with noise every frame
function updateAnimatedRibbons() {
  const globeCenter = globe.position;
  const time = performance.now() * 0.0002;
  for (const ribbon of animatedRibbons) {
    // Remove previous mesh if exists
    if (ribbon.mesh) {
      scene.remove(ribbon.mesh);
      if (ribbon.mesh.geometry) ribbon.mesh.geometry.dispose();
      if (ribbon.mesh.material) ribbon.mesh.material.dispose();
      ribbon.mesh = null;
    }
    // Animate drawIndex if animating
    if (ribbon.animating) {
      ribbon.drawIndex += 2;
      if (ribbon.drawIndex >= ribbon.arcPointsBase.length) {
        ribbon.drawIndex = ribbon.arcPointsBase.length;
        ribbon.animating = false;
      }
    }
    // Apply noise to arc points, but keep ends fixed (no noise at ends)
    const arcPoints = ribbon.arcPointsBase
      .slice(0, ribbon.drawIndex)
      .map((p, i, arr) => {
        if (i === 0 || i === arr.length - 1) return p.clone(); // no noise at ends
        return applyNoiseToPoint(
          p,
          i / (arr.length - 1),
          ribbon.arcId,
          0.05,
          1.5,
          time
        );
      });
    // --- IMPROVEMENTS START HERE ---

    // 1. Uniform ribbon width
    const baseWidth = ribbon.ribbonWidth;
    // 2. Color gradient: from one color to another
    const colorStart = new THREE.Color(0x33ffaa);
    const colorEnd = new THREE.Color(0xff33aa);

    // 3. Opacity gradient: fade at ends
    const opacityStart = 0.0;
    const opacityMid = 1.0;
    const opacityEnd = 0.0;

    // 4. More complex twisting: modulate twist with noise
    // Clamp twist to +/- 90 degrees (PI/2)
    const twistBase = Math.PI / 2;
    const twistNoiseScale = 1.5;

    // Arrays for geometry attributes
    const extrudePointsLeft = [];
    const extrudePointsRight = [];
    const colors = [];
    const opacities = [];

    for (let i = 0; i < arcPoints.length; i++) {
      let tangent;
      if (i === 0) {
        tangent =
          arcPoints[1]?.clone().sub(arcPoints[0]) || new THREE.Vector3(1, 0, 0);
      } else if (i === arcPoints.length - 1) {
        tangent = arcPoints[i].clone().sub(arcPoints[i - 1]);
      } else {
        tangent = arcPoints[i + 1].clone().sub(arcPoints[i - 1]);
      }
      tangent.normalize();
      const normal = arcPoints[i].clone().sub(globeCenter).normalize();
      let side = tangent.clone().cross(normal).normalize();

      // Vary width along the arc
      const t = i / (arcPoints.length - 1);
      // Use uniform width
      const width = baseWidth;

      // Twisting: modulate twist with noise, clamp to [-PI/2, PI/2]
      // Prevent twist at the very ends (e.g., first and last 5% of the ribbon)
      let twistAmount = 1.0;
      if (t < 0.05) twistAmount = t / 0.05;
      else if (t > 0.95) twistAmount = (1 - t) / 0.05;
      twistAmount = Math.max(0, Math.min(1, twistAmount));
      const twistNoise = noise4D(
        arcPoints[i].x * twistNoiseScale,
        arcPoints[i].y * twistNoiseScale,
        arcPoints[i].z * twistNoiseScale,
        time + ribbon.arcId
      );
      let twistAngle = twistBase * (2 * t - 1) + twistNoise * (Math.PI / 4);
      twistAngle = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, twistAngle));
      twistAngle *= twistAmount;
      const twistQuat = new THREE.Quaternion().setFromAxisAngle(
        tangent,
        twistAngle
      );
      side.applyQuaternion(twistQuat);

      extrudePointsLeft.push(
        arcPoints[i].clone().add(side.clone().multiplyScalar(width / 2))
      );
      extrudePointsRight.push(
        arcPoints[i].clone().add(side.clone().multiplyScalar(-width / 2))
      );

      // Color gradient
      const color = colorStart.clone().lerp(colorEnd, t);
      colors.push(color.r, color.g, color.b);
      colors.push(color.r, color.g, color.b);

      // Opacity gradient (fade at ends, max in middle)
      let opacity = opacityMid;
      if (t < 0.2)
        opacity = THREE.MathUtils.lerp(opacityStart, opacityMid, t / 0.2);
      else if (t > 0.8)
        opacity = THREE.MathUtils.lerp(opacityMid, opacityEnd, (t - 0.8) / 0.2);
      opacities.push(opacity, opacity);
    }

    // Build geometry for the ribbon (as a strip of triangles)
    const ribbonVertices = [];
    const ribbonColors = [];
    const ribbonOpacities = [];
    for (let i = 0; i < arcPoints.length - 1; i++) {
      // Each vertex gets color and opacity
      // left[i], right[i], left[i+1], right[i], right[i+1], left[i+1]
      ribbonVertices.push(
        extrudePointsLeft[i],
        extrudePointsRight[i],
        extrudePointsLeft[i + 1],
        extrudePointsRight[i],
        extrudePointsRight[i + 1],
        extrudePointsLeft[i + 1]
      );
      // Colors and opacities for each vertex
      const idxs = [i, i, i + 1, i, i + 1, i + 1];
      for (const idx of idxs) {
        ribbonColors.push(
          colors[idx * 2],
          colors[idx * 2 + 1],
          colors[idx * 2 + 2]
        );
        ribbonOpacities.push(opacities[idx * 2]);
      }
    }
    const ribbonGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(ribbonVertices.length * 3);
    for (let i = 0; i < ribbonVertices.length; i++) {
      positions[i * 3] = ribbonVertices[i].x;
      positions[i * 3 + 1] = ribbonVertices[i].y;
      positions[i * 3 + 2] = ribbonVertices[i].z;
    }
    ribbonGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(positions, 3)
    );
    ribbonGeometry.computeVertexNormals();

    // Cloth-like material: high roughness, low metalness, double-sided, keep color
    const ribbonMaterial = new THREE.MeshStandardMaterial({
      color: 0xefb6e1,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 1.0,
      roughness: 0.95, // very matte, like cloth
      metalness: 0.05, // almost non-metallic
      sheen: 1.0, // subtle cloth sheen
      sheenColor: new THREE.Color(0xffffff),
      sheenRoughness: 0.7,
    });

    ribbon.mesh = new THREE.Mesh(ribbonGeometry, ribbonMaterial);
    scene.add(ribbon.mesh);
  }
}

function animatePointer(position) {
  // Remove previous pointer
  if (activePointer) {
    scene.remove(activePointer);
    if (activePointer.geometry) activePointer.geometry.dispose();
    if (activePointer.material) activePointer.material.dispose();
    activePointer = null;
  }
  // Create an extruded circle (disk)
  const circleRadius = 0.12;
  const circleShape = new THREE.Shape();
  circleShape.absarc(0, 0, circleRadius, 0, Math.PI * 2, false);
  const extrudeSettings = {
    depth: 0.05,
    bevelEnabled: false,
    steps: 1,
  };
  const circleGeometry = new THREE.ExtrudeGeometry(
    circleShape,
    extrudeSettings
  );
  const circleMaterial = new THREE.MeshStandardMaterial({
    color: 0xe6e1e2,
    metalness: 0.0,
    roughness: 0.3,
  });
  const disk = new THREE.Mesh(circleGeometry, circleMaterial);
  disk.position.copy(position);
  // Orient disk to face outward from globe
  const globeCenter = globe.position;
  const normal = position.clone().sub(globeCenter).normalize();
  const up = new THREE.Vector3(0, 0, 1);
  const quat = new THREE.Quaternion().setFromUnitVectors(up, normal);
  disk.setRotationFromQuaternion(quat);
  // Disk now lies flush on the globe surface (no outward offset)
  scene.add(disk);
  activePointer = disk;
  // Animate scale
  let scale = 1;
  let growing = true;
  let frame = 0;
  function pointerAnim() {
    if (frame > 30) {
      // scene.remove(disk);
      if (disk.geometry) disk.geometry.dispose();
      if (disk.material) disk.material.dispose();
      if (activePointer === disk) activePointer = null;
      return;
    }
    if (growing) {
      scale += 0.05;
      if (scale > 1.5) growing = false;
    } else {
      scale -= 0.05;
    }
    disk.scale.set(scale, scale, scale);
    frame++;
    requestAnimationFrame(pointerAnim);
  }
  pointerAnim();
}

// Responsive resize
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.domElement.addEventListener("click", (event) => {
  // Use bounding rect for accurate mouse position
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObject(globe);
  if (intersects.length > 0) {
    const newPos = intersects[0].point.clone();
    animatePointer(newPos);
    if (lastPointerPosition) {
      animateRibbon(lastPointerPosition, newPos);
    }
    lastPointerPosition = newPos;
  }
});

// function animate() {
//   requestAnimationFrame(animate);
//   controls.update();
//   updateAnimatedRibbons(); // <-- update all ribbons with animated noise
//   renderer.render(scene, camera);
// }
// animate();
//       scale -= 0.05;
//     }
//     pointer.scale.set(scale, scale, scale);
//     frame++;
//     requestAnimationFrame(pointerAnim);
//   }
//   pointerAnim();
// }

// Responsive resize
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.domElement.addEventListener("click", (event) => {
  // Use bounding rect for accurate mouse position
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObject(globe);
  if (intersects.length > 0) {
    const newPos = intersects[0].point.clone();
    animatePointer(newPos);
    if (lastPointerPosition) {
      animateRibbon(lastPointerPosition, newPos);
    }
    lastPointerPosition = newPos;
  }
});

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  // Update fill and rim light positions to follow camera
  const cameraDir = new THREE.Vector3();
  camera.getWorldDirection(cameraDir);
  // Fill light: from camera toward globe
  fillLight.position
    .copy(camera.position)
    .add(cameraDir.clone().multiplyScalar(-1));
  fillLight.target.position.copy(globe.position);
  // Rim light: from behind camera (opposite direction)
  rimLight.position
    .copy(camera.position)
    .add(cameraDir.clone().multiplyScalar(2));
  rimLight.target.position.copy(globe.position);
  updateAnimatedRibbons(); // <-- update all ribbons with animated noise
  renderer.render(scene, camera);
}
animate();
// safe twist
