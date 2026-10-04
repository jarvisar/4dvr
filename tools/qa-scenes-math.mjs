import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as P from '../src/four/polytopes.js';
import * as R from '../src/math/rot4.js';
import * as H from '../src/math/hyperbolic.js';
import * as S from '../src/math/spherical.js';
import { SliceView } from '../src/four/sliceView.js';
import { tesseractNet } from '../src/four/tesseractNet.js';
import { World4, Body4 } from '../src/physics/world4.js';

const results=[];
for(const [name,expected] of Object.entries({simplex:[5,10,10,5],tesseract:[16,32,24,8],orthoplex:[8,24,32,16],icositetrachoron:[24,96,96,24],hecatonicosachoron:[600,1200,720,120],hexacosichoron:[120,720,1200,600]})){
  const p=P[name]();const counts=[p.vertices.length,p.edges.length,p.faces.length,p.cells.length];
  assert.deepEqual(counts,expected,name);
  const incidence=new Array(p.faces.length).fill(0);for(const c of p.cells)for(const f of c.faces)incidence[f]++;
  assert.ok(incidence.every(n=>n===2),`${name}: each face belongs to two cells`);
  assert.equal(counts[0]-counts[1]+counts[2]-counts[3],0,`${name}: Euler characteristic`);
  results.push({name,counts,facesHaveTwoCells:true});
}
let maximumInverseError=0;
const view=new SliceView();view.w=0.24;view.setAngles(0.91,-0.7);
for(let n=0;n<1000;n++){
  const p=[Math.sin(n),Math.cos(n*2),Math.sin(n*3),Math.cos(n*7)];
  const back=view.toWorld([0,0,0,0],view.toSlice([0,0,0,0],p));
  maximumInverseError=Math.max(maximumInverseError,...p.map((x,i)=>Math.abs(x-back[i])));
}
assert.ok(maximumInverseError<1e-12);results.push({name:'Slice/world round trip',maximumInverseError});
for(const distance of [0,0.001,0.1,1,5,10]){
  const boost=H.boost(R.mat4(),[distance,0,0]);
  const p=R.apply([0,0,0,0],boost,H.ORIGIN);
  assert.ok(Math.abs(H.hdist(p,H.ORIGIN)-distance)<1e-9);
  const t=S.translation(R.mat4(),distance,0,0);
  const sp=R.apply([0,0,0,0],t,S.ORIGIN);
  assert.ok(Math.abs(S.dot4(sp,sp)-1)<1e-12);
}
results.push({name:'Hyperbolic boost distances and spherical unit norms',passed:true});
const folded=tesseractNet(1);const unique=new Set(folded.vertices.map(p=>p.map(x=>x.toFixed(6)).join(',')));
assert.equal(unique.size,16);results.push({name:'Folded tesseract net has 16 unique vertices',passed:true});
const world=new World4({floorY:0,wallRadius:0.6,wRange:0.55});
const sphere=new Body4({type:'sphere',r:1},0.05);sphere.x=[0,0.7,0,0];world.add(sphere);
for(let i=0;i<1200;i++)world.step(1/120);
assert.ok(sphere.sleeping);assert.ok(Math.abs(sphere.x[1]-0.05)<0.002);assert.ok(sphere.x.every(Number.isFinite));
results.push({name:'Sphere falls, lands and sleeps',position:sphere.x,sleeping:sphere.sleeping});
const free=new World4({floorY:-Infinity,gravity:[0,0,0,0]});free.linearDamping=0;free.angularDamping=0;
const box=new Body4({type:'box',h:[0.08,0.04,0.05,0.03]},1);free.add(box);box.setAngularVelocity([1.1,-0.8,0.2,0.9,0.4,-0.5]);
const initialL=box.L.slice();
const energy=b=>0.5*b.L.reduce((sum,l,i)=>sum+l*b.w[i],0);
const before=energy(box);
for(let i=0;i<6000;i++)free.step(1/120);
const after=energy(box);
assert.ok(box.R.every(Number.isFinite));assert.ok(Math.abs(after-before)/before<0.001);
assert.deepEqual(box.L,initialL);
results.push({name:'Free anisotropic rotation conserves momentum and energy over 50 seconds',relativeEnergyDrift:(after-before)/before});
fs.mkdirSync('smoke-artifacts/qa-scenes',{recursive:true});
fs.writeFileSync('smoke-artifacts/qa-scenes/math-checks.json',JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
