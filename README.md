# 4D VR

WebXR app for viewing and interacting with 4D objects, higher-dimensional geometry, and hyperbolic space. Built with [Three.js](https://threejs.org/) for the Meta Quest with hand tracking. Controllers are also supported, and every scene works in a desktop browser with a mouse and keyboard.

Visit the [GitHub Pages site](https://ajarvis.co/anakata/) to access the latest deployment.

## Scenes

- **Hyperplay:** 4D physics sandbox on a table. Includes all six regular 4-polytopes, hyperspheres, duocylinders, spherinders, cubinders, and a tiger. Objects are shown as 3D cross-sections, and the cross-section can be moved along the W axis or rotated in the xw/zw planes. One of the presets is a sealed glass box where the ball has to be moved out through W.
- **Polytope Lab:** The regular 4-polytopes shown as perspective or stereographic projections, with the current cross-section drawn inside. Also includes a tesseract net that folds into a tesseract, and cross-sections of curved shapes like the spheritorus and torisphere.
- **Knot Lab:** A rope simulated in 4D. Strands only collide when they are close in all four coordinates, so a strand moved in W can pass through another one. Includes a trefoil, figure-eight knot, Hopf link, and Borromean rings. The scene detects when a knot is untied or a link is separated.
- **Hopf Garden:** The Hopf fibration of the 3-sphere, stereographically projected. Touch the globe to add the fiber for that point. Rotating the globe rotates all of the fibers.
- **Hyperbolic Space:** The {5,3,4} honeycomb (right-angled dodecahedra) and {4,3,5} honeycomb (cubes, five around each edge), viewed from inside. Head movement is tracked in hyperbolic space, so walking in a loop leaves you rotated (holonomy).

## Controls

### Hand Tracking

Pinch with the thumb and index finger to grab, move, and throw objects. Pinch with the middle finger and move the hand to rotate an object through 4D. The object rotates in the plane made by the hand's direction and W.

Pinch empty space and move up or down to move the slice along W. Middle-finger pinch empty space and move sideways to rotate the slice.

Turn a palm towards your face to open the menu and press buttons with the other index finger. The menu has tabs for switching scenes and a Help button that shows the controls. Point and pinch to use distant UI.

### Controllers

Use the trigger to grab, move, and throw objects, and the grip to rotate them through 4D. Push either stick up or down to move the slice along W, or left and right to rotate it. Press A or X to open the menu. Point and pull the trigger to use distant UI.

### Desktop

Left drag to grab, move, and throw objects. Right drag to rotate them through 4D, or right drag on empty space to rotate the slice. Use the scroll wheel or Q/E to move the slice along W, and A/D to rotate it.

Press 1–5 to switch scenes, M to toggle the menu, and H to toggle the controls.

On touch screens, drag an object to move it and drag empty space to orbit. Rotating objects through 4D, changing a strand's W, and moving in Hyperbolic Space require a mouse and keyboard or a headset.

### Scene Controls

In Hyperbolic Space, pinch empty space to move through the space. On desktop, use WASD to move and drag to look.

In Hopf Garden, touch the globe to add fibers and pinch it to rotate it.

## Local Installation

Requires [Node.js](https://nodejs.org/) 20.19 or newer.

1. Clone the repository and install the dependencies:

```sh
git clone https://github.com/jarvisar/anakata.git
cd anakata
npm install
```

2. Start the dev server:

```sh
npm run dev
```

The app will be served at `https://localhost:5173` with a self-signed certificate, since WebXR requires HTTPS.

3. To use it on a Quest, connect the headset to the same network as the PC, open `https://<pc-ip>:5173` in the Quest Browser, accept the certificate warning, and press **Enter VR**.

Other commands:

```sh
npm run dev:http    # dev server over http (desktop only)
npm run build       # production build in dist/
npm run preview     # serve the production build
npm run test:smoke  # build and run the headless Chrome tests (requires Chrome)
```

Pushing to `main` builds the site, runs the smoke tests, and deploys it to GitHub Pages. Pull requests and other branches run the same tests and upload screenshots of each scene as artifacts.

### URL Parameters

- `?scene=playground|gallery|knots|hopf|hyperbolic` sets the starting scene
- `?desktop` skips the start screen
- `?quality=low|medium|high` uses a graphics preset for this visit without changing the saved one
- `?scale=1` sets the XR framebuffer scale directly, overriding the preset's resolution
- `?hz=90` sets a fixed refresh rate
- `?stats` shows the frame rate, CPU time, draw calls, triangle count, and resolution per eye in VR. In VR the frame rate is shown as measured/target.
- `?iwer` emulates a Quest 3 with [IWER](https://github.com/meta-quest/immersive-web-emulation-runtime) so VR mode can be tested in a desktop browser. `?iwer=headless` loads it without the control panel.

## Implementation

### Slicing

4D objects are stored as tetrahedral meshes of their 3D boundary, the same approach used by 4D Toys. Polytope cells are split into tetrahedra from the cell center. Curved shapes are built from prisms and cubes, split with consistent diagonals so the cross-sections have no gaps. See [tetmesh.js](src/four/tetmesh.js).

The slicing is done in the vertex shader in [sliceMaterial.js](src/four/sliceMaterial.js). Each tetrahedron is stored in a float texture and drawn as 4 vertices. The shader moves its corners so the slice is the hyperplane w = 0, checks which side each corner is on, and uses a 16-case lookup table to output a triangle, a quad, or nothing. Tetrahedra that are nowhere near the slice are skipped after reading only one corner. Moving or rotating an object only updates two uniforms.

Hyperspheres are drawn as regular spheres with radius `sqrt(r² - d²)`, since every cross-section of a hypersphere is a sphere. The fragment shader maps each point back onto the hypersphere to draw an 8-color pattern, which shows rotation in 4D.

### Physics

[world4.js](src/physics/world4.js) and [colliders.js](src/physics/colliders.js) handle the 4D rigid bodies. Each body has a 4x4 rotation matrix and stores its angular momentum as a bivector (6 rotation planes). Collisions are found by testing sample points on each body against the other body's signed distance function, and contacts are solved with sequential impulses. Held objects are moved by setting their velocity towards the hand instead of their position, so they still collide with walls.

### Projections

[projection.js](src/four/projection.js) draws the polytope edges as instanced tubes and projects them to 3D in the vertex shader. Color shows the W coordinate, and edges are highlighted where they cross the slice.

### Hopf Fibration

Each fiber of the Hopf map is a great circle, and stereographic projection maps great circles to circles. The shader in [hopf.js](src/scenes/hopf.js) finds each circle from three projected points and spaces the vertices evenly around it. Rotating the globe by a quaternion u multiplies every fiber by u on the left, which keeps each fiber attached to its base point.

### Hyperbolic Space

Based on [Non-Euclidean Virtual Reality](https://arxiv.org/abs/1702.04004) by Hart, Hawksley, Matsumoto, and Segerman. See [hyperbolic.js](src/scenes/hyperbolic.js).

Points are stored in the hyperboloid model and drawn using the Beltrami-Klein model. Each frame, head movement is converted to a hyperbolic translation and rotation, and each eye gets its own offset. When the viewer leaves the center cell, a symmetry of the honeycomb moves them back, which keeps the coordinates small without changing what is drawn.

###### Note: this relies on each eye being rendered separately. Three.js's `WebGLRenderer` does not support multiview.

### Knots

[knots.js](src/scenes/knots.js) uses position-based dynamics in 4D. A knot counts as untied when a projection of the loop has no crossings.

## Performance

- Graphics presets (Low, Medium, High) are in the menu and saved in the browser. The Quest 1 and 2 start on Medium and other devices start on High.

  | Preset | Resolution | Fixed foveation | Shadows |
  | --- | --- | --- | --- |
  | High | 100% of the display's native resolution | Off | On |
  | Medium | 80% | Low | On |
  | Low | 60% | High | Off |

  In VR, resolution is a fraction of the display's native resolution, e.g. 2064×2208 per eye on the Quest 3 at 100%, about 1650×1770 at 80%. The Quest Browser's default is about 1680×1760. On desktop it is a fraction of the screen's pixel ratio, up to 2. The VR resolution is fixed while a session runs, so changing the preset in the headset changes foveation and shadows right away and the resolution the next time VR starts. 4x MSAA is always on.
- The refresh rate starts at the highest rate the headset supports and drops a step if the scene cannot keep up. Switching scenes goes back to the highest rate.
- No post-processing
- Scenes are loaded when first opened, and the 4D shapes are built before VR starts so choosing a preset in the headset does not stall
- Per-frame code avoids allocations to prevent garbage collection pauses on the headset
- Shadows use a single 1024x1024 shadow map, and are only re-rendered in Hyperplay on frames where something moved

## References

- Marc ten Bosch, [N-Dimensional Rigid Body Dynamics](https://marctenbosch.com/ndphysics/) (SIGGRAPH 2020)
- Hart, Hawksley, Matsumoto, and Segerman, [Non-Euclidean Virtual Reality I](https://arxiv.org/abs/1702.04004) and [II](https://arxiv.org/abs/1702.04862) (2017)
- Hart, Segerman, et al., [Hypernom](https://arxiv.org/abs/1507.05707) (2015)
- CodeParade, [Engine4D](https://github.com/HackerPoet/Engine4D)
- Niles Johnson, [Hopf fibration visualizations](https://nilesjohnson.net/hopf.html)
- Andrew Hanson, rolling ball method for 4D rotation
- Dompierre et al., How to Subdivide Pyramids, Prisms and Hexahedra into Tetrahedra (1999)
