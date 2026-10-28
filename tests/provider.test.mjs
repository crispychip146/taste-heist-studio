import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Qloo, normalizeEntity, recommendationArguments } from '../server/qloo.mjs';
import { Harness, harnessEnvironment, runHarness, workflowEntities } from '../server/harness.mjs';
import { ProviderError } from '../server/errors.mjs';
import { Artwork, trustedImage, imagePathFor } from '../server/artwork.mjs';
import { researchCrew, rpc } from '../server/agent.mjs';
import { id, record, entity, recommendationTool } from './fixtures.mjs';

function harness(call = async () => ({status:'ok',results:[record(100)]})) {
  const calls=[];
  return { env:{QLOO_API_KEY:'test-secret-only'}, credentialReady:true, tools:new Map([['qloo_recommend',recommendationTool]]), connect:async()=>{},
    search:async(query,type)=>({success:true,results:[record(query==='second'?2:1,type)]}),
    call:async(name,args)=>{calls.push({name,args});return call(name,args);}, close:async()=>{}, calls,
  };
}
const profiles=[{id:'local-a',favorites:[entity(1),entity(2,'book')]},{id:'local-b',favorites:[entity(3),entity(4,'artist')]}];
test('metadata normalization preserves real category, artwork, year and attribution; projections can omit raw evidence',()=>{
  const result=normalizeEntity(record(1,'book',{publication_year:1985,authors:[{name:'Test Author'}],image:{url:'https://images.qloo.com/i/book.jpg',attribution:'Provider credit'}}),'movie');
  assert.equal(result.type,'book');assert.equal(result.imageSource,'https://images.qloo.com/i/book.jpg');assert.equal(result.imageAttribution,'Provider credit');assert(result.detail.includes('Test Author'));
  assert.equal(normalizeEntity({name:'Unidentified item'},'movie'),null);
});
test('recommendation inputs follow discovered schemas, preserve IDs and fail closed for unsupported reference shapes',()=>{
  const args=recommendationArguments(recommendationTool,profiles[0].favorites,'book',20);
  assert.deepEqual(args.signals,[id(1),id(2)]);assert.equal(args.target_type,'book');assert.equal(args.limit,20);
  const objectTool=structuredClone(recommendationTool);objectTool.inputSchema.properties.signals.items={type:'object',required:['entity_id','weight'],properties:{entity_id:{type:'string'},weight:{type:'number'}}};
  assert.deepEqual(recommendationArguments(objectTool,profiles[0].favorites,'movie',12).signals[0],{entity_id:id(1),weight:1});
  const bad=structuredClone(recommendationTool);bad.inputSchema.properties.signals.items={type:'object',properties:{only_names:{type:'string'}}};
  assert.throws(()=>recommendationArguments(bad,profiles[0].favorites,'movie',12),error=>error.code==='QLOO_CONTRACT');
});
test('all workflow statuses are handled; raw provider messages cannot leak credentials',()=>{
  assert.deepEqual(workflowEntities({status:'empty'}),[]);
  for(const status of ['partial','degraded','needs_input'])assert.throws(()=>workflowEntities({status}),ProviderError);
  assert.throws(()=>workflowEntities({status:'error',summary:'test-secret-only',error:{code:'QLOO_AUTH',retryable:false,recovery:'test-secret-only'}}),error=>error.code==='QLOO_AUTH'&&!error.message.includes('test-secret-only')&&!error.retryable);
  assert.throws(()=>workflowEntities({status:'mystery',results:[]}),error=>error.code==='QLOO_CONTRACT');
});
test('independent research excludes every crew favourite and coalesces reusable requests',async()=>{
  const h=harness(async(name,args)=>({status:'ok',results:[record(1,args.target_type),record(100,args.target_type)]})),qloo=new Qloo({harness:h});const progress=[];
  const results=await qloo.research(profiles,event=>progress.push(event));
  assert.equal(h.calls.length,6);assert(results.every(result=>result.entities.every(item=>item.id!==id(1))));
  assert.equal(h.calls[0].args.signals.includes('local-a'),false);assert.equal(progress.at(-1).completed,6);
  await qloo.research(profiles);assert.equal(h.calls.length,6);assert(qloo.status().verifiedAt);await qloo.close();
});
test('empty overlap broadens once within the budget without inventing membership',async()=>{
  const h=harness(async(name,args)=>({status:'ok',results:[record(args.signals[0]===id(1)?101:102,args.target_type)]})),qloo=new Qloo({harness:h});
  const results=await qloo.research(profiles);assert.equal(h.calls.length,12);assert(results[0].entities.every(item=>!results[1].entities.some(other=>other.id===item.id)));await qloo.close();
});
test('search requests coalesce and profile caches never depend on player identifiers',async()=>{
  let count=0;const h=harness();h.search=async()=>{count++;await new Promise(resolve=>setImmediate(resolve));return{success:true,results:[record(1)]};};
  const qloo=new Qloo({harness:h});await Promise.all([qloo.search('A title','movie'),qloo.search('A title','movie')]);assert.equal(count,1);
  await assert.rejects(qloo.search('--api-key','movie'),error=>error.code==='SEARCH_INPUT');await qloo.close();
});
test('harness process gets the key through environment, uses no shell and never forwards raw stderr',async()=>{
  let captured;
  const spawnProcess=(command,args,options)=>{
    captured={command,args,options};const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    queueMicrotask(()=>{child.stderr.write('test-secret-only');child.stdout.write(JSON.stringify({success:true,results:[]}));child.emit('close',0);});return child;
  };
  const result=await runHarness(['api','search','--query','A title','--json'],{env:{QLOO_API_KEY:'test-secret-only'},spawnProcess});
  assert.deepEqual(result.results,[]);assert.equal(captured.options.shell,false);assert.equal(captured.options.env.QLOO_API_KEY,'test-secret-only');assert(!JSON.stringify(captured.args).includes('test-secret-only'));
  assert.equal(captured.options.env.QLOO_BASE_URL,'https://hackathon.api.qloo.com');assert.throws(()=>harnessEnvironment({QLOO_BASE_URL:'https://api.qloo.com'}),error=>error.code==='QLOO_HOST');
});
test('official MCP connection discovers tools and checks credential readiness before recommendations',async()=>{
  const calls=[];let closed=false;
  const client={listTools:async()=>({tools:[recommendationTool,{name:'qloo_capabilities'}]}),callTool:async call=>{calls.push(call);return{structuredContent:{adapter:{ready:true}}};},close:async()=>{closed=true;}};
  const h=new Harness({env:{QLOO_API_KEY:'test-secret-only'},clientFactory:async()=>client});await h.connect();assert.equal(h.credentialReady,true);assert.equal(calls[0].name,'qloo_capabilities');await h.close();assert(closed);
  const invalid=new Harness({env:{},clientFactory:async()=>({...client,callTool:async()=>({structuredContent:{adapter:{ready:false}}})})});
  await assert.rejects(invalid.connect(),error=>error.code==='QLOO_AUTH');await invalid.close();
});
test('artwork accepts only trusted HTTPS images, validates bytes, caches and sends no API credential',async()=>{
  const jpeg=Buffer.from([255,216,255,217]);let count=0;
  const art=new Artwork({fetcher:async(url,options)=>{count++;assert(!options.headers['X-Api-Key']);return new Response(jpeg,{headers:{'content-type':'image/jpeg'}});}});
  const result=await art.get('https://images.qloo.com/i/test.jpg');assert.equal(result.type,'image/jpeg');await art.get('https://images.qloo.com/i/test.jpg');assert.equal(count,1);
  for(const url of ['http://images.qloo.com/test','https://images.qloo.com.evil.test/x','https://127.0.0.1/x','https://user:pass@images.qloo.com/x'])assert.equal(trustedImage(url),null);
  assert.equal(imagePathFor({...entity(1),imageSource:'https://evil.test/x'}),null);
  const redirect=new Artwork({fetcher:async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/internal'}})});
  await assert.rejects(redirect.get('https://images.qloo.com/test'),error=>error.code==='IMAGE_UNAVAILABLE');
  const spoof=new Artwork({fetcher:async()=>new Response('<script>bad()</script>',{headers:{'content-type':'image/jpeg'}})});
  await assert.rejects(spoof.get('https://images.qloo.com/test'),error=>error.code==='IMAGE_UNAVAILABLE');
});
test('agent tool uses the same service and keeps novelty as a human decision',async()=>{
  const qloo=new Qloo({harness:harness()});const result=await researchCrew({profiles:profiles.map(p=>({id:p.id,entityIds:p.favorites.map(entity=>entity.id)}))},qloo);
  assert.equal(result.sharedCandidates[0].id,id(100));assert.match(result.nextAction,/human|person/);assert(!JSON.stringify(result).includes('test-secret-only'));
  assert.equal((await rpc({method:'tools/list'})).tools[0].name,'research_taste_crew');await qloo.close();
});
