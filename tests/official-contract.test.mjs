// Uses the installed official harness and SDK. Only the upstream Qloo HTTP client is controlled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createQlooTools, startCanonicalMcpServer } from '@qloo/qloo-harness';
import { Harness } from '../server/harness.mjs';
import { Qloo, normalizeEntity } from '../server/qloo.mjs';
import { entity, id, record } from './fixtures.mjs';

test('real official MCP server and SDK agree on schemas, UUID resolution, compact evidence and artwork', async () => {
  const calls = [], input = new PassThrough(); let lifecycle;
  const upstream = {
    entities: async ids => { calls.push({ path:'/entities',ids }); return {results:{entities:ids.map(value=>({...record(Number(value.slice(-12))),entity_id:value}))}}; },
    searchEntities: async () => ({results:[]}), searchTags: async()=>({results:[]}),
    insights: async query => { calls.push({path:'/v2/insights',query});return {results:{entities:[{...record(100,query['filter.type'].replace('urn:entity:','')),query:{affinity:.81,explainability:{source:'provider'}}}]}}; },
    compare: async()=>({results:[]}),trending:async()=>({results:[]}),
  };
  const transport = {
    async start() {},
    async send(message) { input.write(JSON.stringify(message)+'\n'); },
    async close() { lifecycle.close();input.end();this.onclose?.(); },
  };
  lifecycle=startCanonicalMcpServer({input,tools:createQlooTools({client:upstream}),writeOut:text=>{for(const line of text.trim().split('\n'))transport.onmessage?.(JSON.parse(line));}});
  const sdk=new Client({name:'taste-heist-contract-test',version:'1.0.0'});await sdk.connect(transport);
  const harness=new Harness({env:{QLOO_API_KEY:'test-only'},clientFactory:async()=>sdk,runner:async(args)=>{
    if(args[1]==='search')return[record(1,'book')];
    assert.equal(args[1],'entity');return args[3].split(',').map(value=>({...record(Number(value.slice(-12))),entity_id:value}));
  }});
  const qloo=new Qloo({harness});
  try {
    const matches=await qloo.search('A test book','book');assert.equal(matches[0].id,id(1));
    const results=await qloo.research([{id:'person-a',favorites:[entity(1),entity(2)]},{id:'person-b',favorites:[entity(3),entity(4)]}]);
    assert.equal(results.length,2);assert(results.every(result=>result.entities.some(item=>item.id===id(100))));
    assert.equal(results[0].entities[0].evidence.affinity,.81);
    assert(calls.some(call=>call.path==='/entities'));assert.equal(calls.filter(call=>call.path==='/v2/insights').length,6);
    assert(calls.filter(call=>call.path==='/v2/insights').every(call=>call.query['signal.interests.entities'].every(id=>/^[a-f0-9-]{36}$/.test(id))));
  }finally{await qloo.close();}
});

test('actual installed CLI array format, flat workflow fields and empty-search errors normalize correctly',async()=>{
  const harness={env:{},credentialReady:true,search:async(query)=>query==='empty'?{error:true,code:'NOT_FOUND',message:'Not found'}:[record(7,'book')],close:async()=>{}};
  const qloo=new Qloo({harness});assert.equal((await qloo.search('A book','book'))[0].id,id(7));assert.deepEqual(await qloo.search('empty','book'),[]);
  const compact=normalizeEntity({...record(9),affinity:.7,explainability:{actual:'evidence'}},'movie');assert.equal(compact.evidence.affinity,.7);assert.deepEqual(compact.evidence.explainability,{actual:'evidence'});await qloo.close();
});
