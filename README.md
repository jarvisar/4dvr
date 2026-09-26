# 4D VR

WebXR app for viewing and interacting with 4D objects, higher-dimensional geometry, and hyperbolic and spherical space. Built with [Three.js](https://threejs.org/) for the Meta Quest with hand tracking. Controllers are also supported, and every scene works in a desktop browser with a mouse and keyboard.

Visit the [GitHub Pages site](https://ajarvis.co/anakata/) to access the latest deployment.

## Scenes

- **Hyperplay:** 4D physics sandbox on a table. Includes all six regular 4-polytopes, hyperspheres, duocylinders, spherinders, cubinders, and a tiger. Objects are shown as 3D cross-sections, and the cross-section can be moved along the W axis or rotated in the xw/zw planes. Shadows are 4D shadows: the sun can lean towards ana, so objects outside the slice cast shadows into it. Presets:
  - **Sealed box:** the ball has to be moved out of a closed glass box through W.
  - **Mirror:** a chiral piece has to go into an outline of its mirror image. No 3D rotation does it, but a half-turn through W does.
  - **Dice:** the regular 4-polytopes as a d5, d8, d16, d24, d120, and d600. A die lands on a cell, and the result is the cell facing up. Opposite cells add up to N + 1, like on a d6.
  - **Orbits:** moons around a sun with 4D gravity, which falls off as 1/r³. Every circular orbit has zero energy, so a small nudge sends a moon into the sun or away for good. Switch to 1/r² to compare.
  - **Shadows:** the sun leans 50° towards ana.
  - **Worldline:** a motion with time as the W axis, so moving the slice replays it and rotating the slice in xw mixes time with space, like a slit-scan photo. Shows juggling by default, and can record 4 seconds of your hands.
- **Polytope Lab:** The regular 4-polytopes shown as perspective or stereographic projections, with the current cross-section drawn inside. Also includes a tesseract net that folds into a tesseract, and cross-sections of curved shapes like the spheritorus and torisphere.
- **Knot Lab:** A rope simulated in 4D. Strands only collide when they are close in all four coordinates, so a strand moved in W can pass through another one. Includes a trefoil, figure-eight knot, Hopf link, and Borromean rings. The scene detects when a knot is untied or a link is separated.
- **Hopf Garden:** The Hopf fibration of the 3-sphere, stereographically projected. Touch the globe to add the fiber for that point. Rotating the globe rotates all of the fibers.
- **Hyperbolic Space:** The {5,3,4} honeycomb (right-angled dodecahedra) and {4,3,5} honeycomb (cubes, five around each edge), viewed from inside. Head movement is tracked in hyperbolic space, so walking in a loop leaves you rotated (holonomy).
- **Spherical Space:** The 120-cell, 24-cell, tesseract, and 5-cell as tilings of the 3-sphere, viewed from inside: three cells around each edge, which leaves a gap in flat space. Walking straight ahead for 2π times the radius brings you back to the start. Every line of sight is a great circle, so everything is also seen the long way round, in the opposite direction, and straight ahead at the end of the long way is the back of your own head.
- **Klein Room:** A room glued to itself. Walk out through the left or right side and you come back in through the other. Walk out through the front or back and you come back mirror-reversed, because that pair of walls is glued with a flip. The floor plan is a Klein bottle. Copies of the room, and of you, are visible through the walls, every other row mirror-reversed. After crossing a flipped wall, text reads backwards and your left hand fits the right-hand print.
- **Quasicrystals:** A Penrose tiling as a 2D slice of the 5D cubic lattice, on the floor around you, and an icosahedral tiling of two rhombohedra as a 3D slice of the 6D lattice. Moving the slice through the hidden dimensions rearranges tiles three at a time (phason flips), but the pattern never repeats.

## Controls

### Hand Tracking

Pinch with the thumb and index finger to grab, move, and throw objects. Pinch with the middle finger and move the hand to rotate an object through 4D. The object rotates in the plane made by the hand's direction and W.

Pinch empty space and move up or down to move the slice along W. Middle-finger pinch empty space and move sideways to rotate the slice.

Turn a palm towards your face to open the menu and press buttons with the other index finger. The menu has tabs for switching scenes and a Help button that shows the controls. Point and pinch to use distant UI.

### Controllers

Use the trigger to grab, move, and throw objects, and the grip to rotate them through 4D. Push either stick up or down to move the slice along W, or left and right to rotate it. Press A or X to open the menu. Point and pull the trigger to use distant UI.

### Desktop

Left drag to grab, move, and throw objects. Right drag to rotate them through 4D, or right drag on empty space to rotate the slice. Use the scroll wheel or Q/E to move the slice along W, and A/D to rotate it.

Press 1–8 to switch scenes, M to toggle the menu, and H to toggle the controls.

On touch screens, drag an object to move it and drag empty space to orbit. Rotating objects through 4D, changing a strand's W, and moving in Hyperbolic Space, Spherical Space, and the Klein Room require a mouse and keyboard or a headset.

### Scene Controls

In Hyperbolic Space, Spherical Space, and the Klein Room, walk or pinch empty space to move through the space. On desktop, use WASD to move and drag to look.

In Hopf Garden, touch the globe to add fibers and pinch it to rotate it.

In Quasicrystals, pinch empty space and move your hand to move the slice through the hidden dimensions. On desktop, right drag.

In Hyperplay's Worldline preset, Record captures 4 seconds of your tracked hands (the controllers, or the mouse on desktop).

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

Open `http://localhost:5173` on the PC. The server also accepts HTTPS on the same port, with a self-signed certificate, since other devices need HTTPS for WebXR.

3. To use it on a Quest, connect the headset to the same network as the PC, open `https://<pc-ip>:5173` in the Quest Browser (`http://` redirects there), accept the certificate warning, and press **Enter VR**.

Other commands:

```sh
npm run build       # production build in dist/
npm run preview     # serve the production build
npm run test:smoke  # build and run the headless Chrome tests (requires Chrome)
```

Pushing to `main` builds the site, runs the smoke tests, and deploys it to GitHub Pages. Pull requests and other branches run the same tests and upload screenshots of each scene as artifacts.

### URL Parameters

- `?scene=playground|gallery|knots|hopf|hyperbolic|spherical|klein|quasicrystal` sets the starting scene
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

### 4D Shadows

A 4D sun shines along a 4D direction. An object's shadow on the floor, which is a 3D hyperplane in 4D, is its projection along that direction, and the slice shows the part of that 3D shadow at w = 0. If the sun has no W component, points keep their w when projected, so this is just the shadow of the cross-section. If it does, objects outside the slice can cast shadows into it.

[shadow4.js](src/four/shadow4.js) compiles the slice shader with `SHADOW4`, which projects each tetrahedron's corners onto the floor before cutting it. The resulting polygons are drawn top-down into a 512x512 mask, and the table multiplies its color by the mask. A hypersphere's shadow is found per pixel: the floor points whose line towards the sun passes within r of its center.

### Physics

[world4.js](src/physics/world4.js) and [colliders.js](src/physics/colliders.js) handle the 4D rigid bodies. Each body has a 4x4 rotation matrix and stores its angular momentum as a bivector (6 rotation planes). Collisions are found by testing sample points on each body against the other body's signed distance function, and contacts are solved with sequential impulses. Held objects are moved by setting their velocity towards the hand instead of their position, so they still collide with walls.

The Mirror preset's piece is a union of four hypercubes (a chiral tetracube thickened along W), with a compound box collider. In the Orbits preset a force field adds 1/r³ (or 1/r²) gravity towards the sun each substep. For 1/r³, the effective potential is (L²/m − GMm)/2r², which has no minimum, so there is no stable orbit.

### Projections

[projection.js](src/four/projection.js) draws the polytope edges as instanced tubes and projects them to 3D in the vertex shader. Color shows the W coordinate, and edges are highlighted where they cross the slice.

### Hopf Fibration

Each fiber of the Hopf map is a great circle, and stereographic projection maps great circles to circles. The shader in [hopf.js](src/scenes/hopf.js) finds each circle from three projected points and spaces the vertices evenly around it. Rotating the globe by a quaternion u multiplies every fiber by u on the left, which keeps each fiber attached to its base point.

### Hyperbolic Space

Based on [Non-Euclidean Virtual Reality](https://arxiv.org/abs/1702.04004) by Hart, Hawksley, Matsumoto, and Segerman. See [hyperbolic.js](src/scenes/hyperbolic.js).

Points are stored in the hyperboloid model and drawn using the Beltrami-Klein model. Each frame, head movement is converted to a hyperbolic translation and rotation, and each eye gets its own offset. When the viewer leaves the center cell, a symmetry of the honeycomb moves them back, which keeps the coordinates small without changing what is drawn.

###### Note: this relies on each eye being rendered separately. Three.js's `WebGLRenderer` does not support multiview.

### Spherical Space

See [spherical.js](src/scenes/spherical.js). Points of S³ are unit vectors in R⁴ and its isometries are rotations of R⁴, so head movement is tracked like in Hyperbolic Space with rotations in place of Lorentz transformations. The polytope's vertices, pushed out onto its circumscribed 3-sphere, give the tiling. S³ is finite, so all of it is drawn.

Every geodesic is a great circle of length 2π, so light from each point reaches the eye along two arcs: the short one (direction u, distance t) and the long one (direction −u, distance 2π − t). Everything is drawn twice, once for each. Each vertex is placed in its true direction at its true distance in metres, which gives every triangle exactly the right outline on screen. Near the antipodal point a small triangle can cover a large part of the view, so depth is written per fragment from the interpolated distance. The avatar around the eyes (head, headset, body, and tracked hands) is only drawn along the long arc, where it fills the background.

### Worldlines

A ball moving along p(t) sweeps out the set of points (x, w(t)) with |x − p(t)| ≤ r: at each moment, a 3D ball in the hyperplane w = w(t). A slice of constant w cuts it in the ball at that moment. A tilted slice cuts each moment's ball in a flat disk, and the cross-section is drawn as a stack of thin disks. See [worldline.js](src/four/worldline.js).

### Klein Room

See [klein.js](src/scenes/klein.js). The room is a fundamental domain of a group of isometries of the plane (times the interval from floor to ceiling), generated by a translation along x and a glide reflection (x, z) → (−x, z + D). Space is flat, so the view is 25 instanced copies of the room, one per group element, and copies of the viewer's head, body, and hands. When the head leaves the room, the map from room coordinates to the real room is composed with the group element it crossed into. After a flipped wall, that map is a reflection. three.js decides which side of a triangle faces the camera per object, not per instance, so mirrored instances are drawn by a second, mirrored instanced mesh.

### Quasicrystals

See [quasicrystal.js](src/scenes/quasicrystal.js). The tilings are built with de Bruijn's dual method, which is equivalent to cutting the lattice. N families of parallel grid lines (planes in 3D) with normals e_j and offsets γ_j are laid out. Every point z where d of them cross, from d different families, gives one tile. It is a rhomb (rhombohedron) with the edges e_j of those families, at Σ K_j e_j with K_j = ⌈z·e_j + γ_j⌉. The Penrose tiling uses 5 directions at 72° with offsets adding up to 0. The 3D tiling uses the 6 icosahedral 5-fold axes. Moving γ along the perpendicular-space vectors e⊥_j moves the slice through the hidden dimensions. The smoke test checks that every inner edge (face in 3D) is shared by exactly two tiles.

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
- Hyperplay's 4D shadows are drawn into a 512x512 mask only on frames where something moved. The three.js shadow map isn't used.
- Quasicrystal tilings are rebuilt at most about 15 times a second while the slice moves

## References

- Marc ten Bosch, [N-Dimensional Rigid Body Dynamics](https://marctenbosch.com/ndphysics/) (SIGGRAPH 2020)
- Hart, Hawksley, Matsumoto, and Segerman, [Non-Euclidean Virtual Reality I](https://arxiv.org/abs/1702.04004) and [II](https://arxiv.org/abs/1702.04862) (2017)
- Hart, Segerman, et al., [Hypernom](https://arxiv.org/abs/1507.05707) (2015)
- CodeParade, [Engine4D](https://github.com/HackerPoet/Engine4D)
- Niles Johnson, [Hopf fibration visualizations](https://nilesjohnson.net/hopf.html)
- Andrew Hanson, rolling ball method for 4D rotation
- Dompierre et al., How to Subdivide Pyramids, Prisms and Hexahedra into Tetrahedra (1999)
- Jeff Weeks, [Curved Spaces](https://www.geometrygames.org/CurvedSpaces/)
- N. G. de Bruijn, Algebraic theory of Penrose's non-periodic tilings of the plane (1981)
- F. Gähler and J. Rhyner, Equivalence of the generalised grid and projection methods for the construction of quasiperiodic tilings (1986)
- P. Ehrenfest, In what way does it become manifest in the fundamental laws of physics that space has three dimensions? (1917)
