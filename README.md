# 4D VR

WebXR app for viewing and interacting with 4D objects, higher-dimensional geometry and hyperbolic space. Built with [Three.js](https://threejs.org/) and designed for Meta Quest headsets with hand tracking. Controllers are also supported, and every scene can be used in a desktop browser with a mouse and keyboard.

## Scenes

- **Hyperplay:** 4D physics sandbox on a table. Includes tesseracts, hyperspheres, the 5-cell, 16-cell, 24-cell, 120-cell and 600-cell, duocylinders, spherinders, cubinders and a tiger. Objects are shown as 3D cross-sections of the 4D scene, and the cross-section can be moved along the W axis or rotated in the xw/zw planes. Presets include a sealed glass box, where the ball has to be moved out through W.
- **Polytope Lab:** The regular 4-polytopes shown as perspective or stereographic projections, with the current cross-section drawn inside the projection. Also includes an animation of the tesseract net folding into a tesseract, and cross-sections of curved 4D shapes (tiger, spheritorus, torisphere, duocylinder, cubinder, spherinder).
- **Knot Lab:** A rope simulated in 4D. Strands only collide when they are close in all four coordinates, so a strand moved in W can pass through another one. Includes a trefoil, figure-eight knot, Hopf link and Borromean rings. The scene detects when a knot has been untied or a link separated.
- **Hopf Garden:** The Hopf fibration of the 3-sphere, stereographically projected. Touching the globe adds the fiber for that point. Rotating the globe rotates all of the fibers.
- **Hyperbolic Space:** The {5,3,4} (right-angled dodecahedra) and {4,3,5} (cubes, five per edge) honeycombs, viewed from inside. Head movement is tracked in hyperbolic space, so walking in a loop leaves you rotated (holonomy).

## Controls

| Action | Hands | Controllers | Desktop |
| --- | --- | --- | --- |
| Grab, move, throw | Pinch (thumb + index) | Trigger | Left drag |
| Rotate through 4D | Middle-finger pinch, then move your hand. The object rotates in the plane of the hand direction and W. | Grip | Right drag |
| Move the slice along W | Pinch empty space and move up or down | Left or right stick up/down | Scroll wheel, Q/E |
| Rotate the slice (xw/zw) | Middle-finger pinch empty space and move sideways | Stick left/right | Right drag on empty space, A/D |
| Menu | Turn a palm towards your face, press buttons with the other index finger | A / X | Panel on the right (M toggles it) |
| Controls help | Help button in the menu | Help button in the menu | Help button or H toggles the controls card |
| Switch scene | Tabs in the menu | Tabs in the menu | 1–5, or the tab bar |
| Distant UI | Point and pinch | Point and pull the trigger | Click |

In Hyperbolic Space, pinching empty space moves you through the space. On desktop, use WASD to move and drag to look. In Hopf Garden, touch the globe to add fibers and pinch it to rotate it.

On touch screens, drag an object to move it and drag empty space to orbit. The menu has the slice controls. Rotating objects through 4D, changing a strand's w and moving in Hyperbolic Space need a mouse and keyboard or a headset.

## Local Installation

Requires [Node.js](https://nodejs.org/) 20.19 or newer.

1. Clone the repository and install the dependencies:

```sh
git clone https://github.com/<user>/<repo>.git
cd <repo>
npm install
```

2. Start the dev server:

```sh
npm run dev
```

This serves the app at `https://localhost:5173` with a self-signed certificate. WebXR requires HTTPS.

3. To use it on a Quest, connect the headset to the same network as the PC, open `https://<pc-ip>:5173` in the Quest Browser, accept the certificate warning and press **Enter VR**.

Other commands:

```sh
npm run dev:http    # dev server over plain http (desktop only)
npm run build       # production build in dist/
npm run preview     # serve the production build
npm run test:smoke  # build, then run the headless Chrome tests (requires Chrome)
```

URL parameters:

- `?scene=playground|gallery|knots|hopf|hyperbolic` sets the starting scene
- `?desktop` skips the start screen
- `?scale=0.8` sets the XR framebuffer scale (lower if a Quest 2 drops frames)
- `?hz=90` requests a 90 Hz refresh rate
- `?stats` shows frame rate, CPU time per frame, draw calls and triangles (in the HUD on desktop, in the hand menu in VR)
- `?iwer` emulates a Quest 3 with [IWER](https://github.com/meta-quest/immersive-web-emulation-runtime), so the VR mode can be tried in a desktop browser. Its panel moves the headset, controllers and hands. The start screen links to it when no headset is found. `?iwer=headless` loads the emulator without the panel (used by the smoke tests).

## Deploying

The site is deployed to GitHub Pages with GitHub Actions.

1. Push the repository to GitHub.
2. Go to **Settings > Pages** and set **Source** to **GitHub Actions**.
3. Push to `main`.

[deploy.yml](.github/workflows/deploy.yml) builds the site, runs the smoke tests and deploys `dist/`. [ci.yml](.github/workflows/ci.yml) runs the build and smoke tests on pull requests and other branches, and uploads screenshots of each scene and of the in-headset menus (rendered through IWER) as artifacts. [dependabot.yml](.github/dependabot.yml) checks for npm and Actions updates weekly.

## Implementation

### Slicing

4D objects are stored as tetrahedral meshes of their 3D boundary, the same approach used by 4D Toys. Polytope cells are split into tetrahedra from the cell center. Curved shapes are built from prisms and cubes split into tetrahedra with consistent diagonals so that the cross-sections have no gaps. See [tetmesh.js](src/four/tetmesh.js).

Each tetrahedron is stored in a float texture (9 texels per tetrahedron). The vertex shader in [sliceMaterial.js](src/four/sliceMaterial.js) handles the rest:

- Each tetrahedron is drawn as 4 indexed vertices, and its corners are fetched using `gl_VertexID`.
- The corners are transformed so the viewer's slice is the hyperplane w = 0, then classified by which side of it they are on.
- A 16-case lookup table gives the cross-section as a triangle, a quad or nothing.
- Triangles are wound to match the 4D normal, so back-face culling can be used.

Moving or rotating an object only updates a `mat4` and a `vec4` uniform. Polytope edges are drawn using the barycentric weight of the cell center.

Hyperspheres are drawn as regular spheres with radius `sqrt(r² - d²)`, since every cross-section of a hypersphere is a sphere. The fragment shader maps each point back onto the hypersphere to draw the 8-color pattern, which shows rotation in 4D.

### Physics

[world4.js](src/physics/world4.js) and [colliders.js](src/physics/colliders.js):

- Each body has a position, velocity, 4x4 rotation matrix and angular momentum stored as a bivector (6 rotation planes).
- The inertia tensor is diagonal in the body's bivector basis.
- Collisions test sample points on each body against the other body's signed distance function.
- Contacts are solved with sequential impulses, friction and speculative contacts to prevent tunneling.
- Held objects are moved by setting their velocity towards the hand instead of their position, so they still collide with walls.

### Projections

[projection.js](src/four/projection.js) draws polytope edges as instanced tubes and projects them to 3D in the vertex shader, using either perspective or stereographic projection. Color shows the W coordinate. Edges are highlighted where they cross the slicing hyperplane.

### Hopf fibration

Each fiber of the Hopf map q -> q i q̄ is a great circle, and stereographic projection maps great circles to circles. The shader finds each circle from three projected points and places the vertices evenly around it. Rotating the globe by a quaternion u applies left multiplication by u to every fiber, which keeps each fiber attached to its base point.

### Hyperbolic space

Based on Hart, Hawksley, Matsumoto and Segerman's [Non-Euclidean Virtual Reality](https://arxiv.org/abs/1702.04004). See [hyperbolic.js](src/scenes/hyperbolic.js).

- Points are stored in the hyperboloid model, and the honeycomb cells are generated from the face reflections.
- Geometry is drawn using the Beltrami-Klein model. Each eye is offset separately in hyperbolic space in the vertex shader.
- Head movement each frame is converted to a hyperbolic translation and rotation.
- When the viewer leaves the center cell, a symmetry of the honeycomb moves them back. This keeps coordinates small without changing what is drawn.

### Knots

[knots.js](src/scenes/knots.js) uses position-based dynamics in 4D. A knot is counted as untied when a projection of the loop has no crossings.

## Performance

- No post-processing.
- Scenes are loaded when first opened.
- Instancing keeps draw calls low.
- Shadows use a single 1024x1024 shadow map, and it is only re-rendered in scenes that have shadow receivers (Hyperplay).
- The sky is drawn after the other opaque objects, so the depth test skips the sky wherever something covers it.
- Per-frame code avoids allocations (physics contacts are pooled, the knot tube is built into reused buffers, labels that change are redrawn in place) to avoid garbage-collection pauses on the headset.
- The hyperbolic per-eye transform is computed once per eye on the CPU, not per vertex.
- The hyperbolic honeycomb uses about 100k vertices.
- `WebGLRenderer` does not support multiview, so each eye is rendered separately. The hyperbolic shader relies on this.

## Project Structure

```
src/
  core/      app, input, interaction, UI panels, menus, audio, environment
  math/      4D vectors, rotations, bivectors, hyperbolic geometry
  four/      polytopes, tetrahedral meshes, slicing, hyperspheres, projections, tesseract net
  physics/   4D rigid bodies and colliders
  scenes/    playground, gallery, knots, hopf, hyperbolic
tools/       headless smoke and interaction tests
```

## References

- Marc ten Bosch, [N-Dimensional Rigid Body Dynamics](https://marctenbosch.com/ndphysics/) (SIGGRAPH 2020)
- Hart, Hawksley, Matsumoto, Segerman, [Non-Euclidean Virtual Reality I](https://arxiv.org/abs/1702.04004) and [II](https://arxiv.org/abs/1702.04862) (2017)
- Hart, Segerman et al., [Hypernom](https://arxiv.org/abs/1507.05707) (2015)
- CodeParade, [Engine4D](https://github.com/HackerPoet/Engine4D)
- Niles Johnson, [Hopf fibration visualizations](https://nilesjohnson.net/hopf.html)
- Andrew Hanson, rolling ball method for 4D rotation
- Dompierre et al., How to Subdivide Pyramids, Prisms and Hexahedra into Tetrahedra (1999)
