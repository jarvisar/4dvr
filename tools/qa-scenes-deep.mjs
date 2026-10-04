import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
// Known dodecahedral return errors: allow improvements, fail on larger residuals.
const MAX_RETURN_RESIDUAL = { 20: 0.001, 40: 8, 825: 1600 };
fs.mkdirSync('smoke-artifacts/qa-scenes',{recursive:true});
const browser = await puppeteer.launch({ executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:'new',args:['--no-sandbox','--ignore-certificate-errors','--enable-unsafe-swiftshader','--use-angle=swiftshader'] });
const page = await browser.newPage();
const errors=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error'&&!/WebXR|favicon|GPU stall|software WebGL/.test(message.text()))errors.push(message.text());});
await page.setRequestInterception(true);
page.on('request',request=>{
  if(new URL(request.url()).hostname==='fonts.googleapis.com')request.respond({status:200,contentType:'text/css',body:''});
  else request.continue();
});
try {
  const url = new URL(process.env.QA_BASE || 'http://127.0.0.1:5173/');
  url.searchParams.set('desktop', '');
  await page.goto(url.href,{waitUntil:'networkidle0'});
  await page.waitForFunction(()=>window.__app?.frameCount>5);
  const results = await page.evaluate(async()=>{
    const app=window.__app; app.renderer.setAnimationLoop(null);
    const { Interactor }=await import('/src/core/input.js');
    const results={};
    app.setScene('playground',true);
    app.setScene('gallery'); app.setScene('playground');
    results.lastSelectionRace={active:app.sceneKey,pending:app._pendingScene,fadeTarget:app.fadeTarget};
    app._pendingScene=null;app.fadeTarget=0;
    results.twoHandEmpty=[];
    for (const key of ['playground','gallery','hopf','hyperbolic','spherical','klein','quasicrystal']) {
      app.setScene(key,true);const s=app.activeScene;
      const a=new Interactor(8),b=new Interactor(9);
      Object.defineProperty(app.input,'all',{value:[a,b],configurable:true});
      for(const ix of [a,b]){ix.kind='hand';ix.active=true;ix.hasPoke=false;ix.grabPos.set(0.9,1.3,0.4);ix.rayOrigin.copy(ix.grabPos);}
      b.grabPos.set(-0.9,1.3,0.4);b.rayOrigin.copy(b.grabPos);
      a.pinch.set(true);app.interaction._update(a,s,1/72);a.pinch.set(true);
      b.pinch.set(true);app.interaction._update(b,s,1/72);b.pinch.set(true);
      const bCaptured=!!b.emptyGrab;
      const before=s.pull?.last?.toArray()||s.air?.start?.toArray()||s._air?.start?.toArray();
      app.interaction._update(a,s,1/72);
      const after=s.pull?.last?.toArray()||s.air?.start?.toArray()||s._air?.start?.toArray();
      const Hm=Array.from(s.Hm||[]),room=s.M?.elements?.slice(),delta=s.delta2?.slice(),viewW=s.view?.w,sliceW=s.sliceW;
      app.interaction.release(b);
      results.twoHandEmpty.push({key,bCaptured,before,after,Hm,room,delta,viewW,sliceW,stateAfterOtherRelease:!!(s.pull||s.air||s._air||s.pending),aStillCaptured:!!a.emptyGrab});
      app.interaction.release(a);
      delete app.input.all;
    }
    app.setScene('hyperbolic',true);const h=app.activeScene;h.goHome();h.walk.keys.add('KeyW');h.walk.keys.add('ShiftLeft');
    let firstNonfinite=null; const samples=[];
    for(let i=0;i<27000;i++){
      h.update(1/72,app.time+=1/72);
      if(i%3600===0)samples.push({seconds:(i+1)/72,homeDistance:h.homeDistance,home:h.home.slice(),HmFinite:Array.from(h.Hm).every(Number.isFinite)});
      if(!Number.isFinite(h.homeDistance)){firstNonfinite={frame:i+1,seconds:(i+1)/72,distance:String(h.homeDistance),home:h.home.map(String),HmFinite:Array.from(h.Hm).every(Number.isFinite)};break;}
    }
    h.walk.keys.clear();results.hyperbolicLongTravel={samples,firstNonfinite,finalDistance:h.homeDistance,expectedDistance:27000/72*2.2,homeFinite:h.home.every(Number.isFinite),beaconFinite:Array.from(h.beaconModel).every(Number.isFinite),storedCrossings:h.homeSteps.length};
    h.goHome();h.update(1/72,app.time+=1/72);results.hyperbolicRecover={distance:h.homeDistance,HmFinite:Array.from(h.Hm).every(Number.isFinite)};
    results.hyperbolicRetrace=[];
    for(const distance of [20,40,825]){
      h.goHome();h.walk.keys.add('KeyW');h.walk.keys.add('ShiftLeft');
      const frames=Math.round(distance/(2.2/72));
      for(let i=0;i<frames;i++)h.update(1/72,app.time+=1/72);
      const outward=h.homeDistance;
      h.walk.keys.delete('KeyW');h.walk.keys.add('KeyS');
      for(let i=0;i<frames;i++)h.update(1/72,app.time+=1/72);
      h.walk.keys.clear();results.hyperbolicRetrace.push({distance,outward,returned:h.homeDistance,home:h.home.slice(),scale:h.homeLogScale,beaconVisible:h.beacon.visible,HmFinite:Array.from(h.Hm).every(Number.isFinite),storedCrossings:h.homeSteps.length});
    }
    app.setScene('spherical',true);const s=app.activeScene;s.goHome();s.walk.keys.add('KeyW');
    for(let i=0;i<12000;i++)s.update(1/72,app.time+=1/72);
    s.walk.keys.clear();results.sphericalLongTravel={distance:s.homeDistance,HmFinite:Array.from(s.Hm).every(Number.isFinite)};
    app.setScene('playground',true);const pg=app.activeScene;pg.loadPreset('dice');
    for(let i=0;i<1440;i++)pg.update(1/72,app.time+=1/72);
    results.diceSettle=pg.dice.map(d=>({name:d.name,result:d.result,sleeping:d.toy.body.sleeping,w:d.toy.body.x[3],y:d.toy.body.x[1],finite:d.toy.body.x.every(Number.isFinite)}));
    pg.loadPreset('worldline');pg.startRecording();
    for(let i=0;i<560;i++)pg.update(1/72,app.time+=1/72);
    results.worldlineRecording={recActive:!!pg.rec,empty:pg.worldline.empty,playing:pg.playing,duration:pg.worldlineDuration,min:pg.worldline.wMin,max:pg.worldline.wMax};
    pg.loadPreset('sandbox');for(let i=0;i<45;i++)pg.spawn('hypersphere');
    results.spawnCap={toys:pg.toys.length,bodies:pg.world.bodies.length,interactables:pg.interactables.length};
    app.setScene('quasicrystal',true);const q=app.activeScene;q.drift=false;
    results.quasicrystalLargeOffsets=[];
    for(const mode of ['floor','crystal']){q.setMode(mode);q.shift(100,-200,300);q.rebuild(app.time);results.quasicrystalLargeOffsets.push({mode,count:mode==='floor'?q.floor.count:q.crystal.count,offset:mode==='floor'?q.delta2.slice():q.delta3.slice()});q.reset();}
    return results;
  });
  fs.writeFileSync('smoke-artifacts/qa-scenes/deep-checks.json',JSON.stringify(results,null,2));
  const failed=errors.map(error=>`Browser error: ${error}`);
  if(results.lastSelectionRace.pending!==null)failed.push('Last scene selection did not cancel the pending scene');
  for(const r of results.twoHandEmpty)if(r.bCaptured||!r.aStillCaptured||!r.stateAfterOtherRelease)failed.push(`${r.key}: conflicting hand gesture ownership`);
  const h=results.hyperbolicLongTravel;
  if(h.firstNonfinite||!h.homeFinite||!h.beaconFinite||!Number.isFinite(h.finalDistance)||Math.abs(h.finalDistance-h.expectedDistance)>1e-6)failed.push('Hyperbolic long travel lost finite or accurate home tracking');
  if(results.hyperbolicRecover.distance!==0)failed.push('Return to start failed after long travel');
  if(!results.sphericalLongTravel.HmFinite||!Number.isFinite(results.sphericalLongTravel.distance))failed.push('Spherical long travel lost a finite pose or distance');
  for (const r of results.hyperbolicRetrace) {
    if (!r.HmFinite || ![r.outward, r.returned, r.scale, ...r.home].every(Number.isFinite)) {
      failed.push(`${r.distance}-unit Hyperbolic retrace produced nonfinite state`);
      continue;
    }
    const expectedOutward = Math.round(r.distance / (2.2 / 72)) * (2.2 / 72);
    if (Math.abs(r.outward - expectedOutward) > 1e-6) failed.push(`${r.distance}-unit Hyperbolic retrace lost accurate outward tracking`);
    const limit = MAX_RETURN_RESIDUAL[r.distance];
    if (r.returned < 0 || r.returned > limit) failed.push(`${r.distance}-unit Hyperbolic return residual ${r.returned} exceeds the limit of ${limit}`);
  }
  const ordinaryReturn=results.hyperbolicRetrace.find(r=>r.distance===20);
  if(Math.abs(ordinaryReturn.home[3]-1)>0.001)failed.push('Ordinary retraced crossing lost the start position');
  for(const d of results.diceSettle)if(!d.finite||!Number.isInteger(d.result))failed.push(`${d.name}: no finite settled roll`);
  if(results.worldlineRecording.recActive||results.worldlineRecording.empty||!results.worldlineRecording.playing)failed.push('Worldline recording did not finish and play');
  if(results.spawnCap.toys!==32||results.spawnCap.bodies!==32)failed.push('Spawn limit failed');
  for(const q of results.quasicrystalLargeOffsets)if(!(q.count>0))failed.push(`${q.mode}: large offset emptied tiling`);
  console.log(JSON.stringify({failed,hyperbolicLongTravel:h,hyperbolicRetrace:results.hyperbolicRetrace,knownLimitations:results.hyperbolicRetrace.filter(r=>r.returned>0.001).map(r=>({distance:r.distance,returnResidual:r.returned})),hyperbolicRecover:results.hyperbolicRecover,diceSettle:results.diceSettle},null,2));
  if(failed.length)process.exitCode=1;
} finally {await browser.close();}
