import test from "node:test";
import assert from "node:assert/strict";
import { createBillingService, billingCents } from "../../app/js/billing.js";
import { createAuthFlow } from "../../app/js/auth.js";
const A="11111111-1111-4111-8111-111111111111",B="22222222-2222-4222-8222-222222222222",P="33333333-3333-4333-8333-333333333333",R="44444444-4444-4444-8444-444444444444";
const balance=(account_id=A)=>({account_id,charges_total:100,payments_total:25,balance:75});
const row=(account_id=A)=>({account_id,entry_date:"2026-10-01",entry_type:"season_dues",description:"Dues",amount:"100.00",direction:"charge",source_id:R});
function fake(replies) {
 const calls=[];return {calls,from(table){ const call={table,ops:[]}; calls.push(call);const query={};for(const name of ["select","eq","in","order","range","limit","abortSignal","single","maybeSingle","insert"]) query[name]=(...args)=>{call.ops.push([name,...args]);return query;};query.then=(ok,bad)=>Promise.resolve().then(()=>{const r=replies.shift();return typeof r==="function"?r(call):r;}).then(ok,bad);return query;}};
}
const data=(value)=>({data:value,error:null});
test("member reads own summary and ledger with explicit payer filters",async()=>{
 const client=fake([data(balance()),data([row()])]);const service=createBillingService({client,accountId:A});
 assert.equal((await service.summary()).balance,75);assert.equal((await service.ledger()).rows.length,1);
 assert.ok(client.calls.every((c)=>c.ops.some((op)=>op[0]==="eq"&&op[1]==="account_id"&&op[2]===A)));
});
test("member cannot request other accounts, admin lists, player lists or writes",async()=>{
 const client=fake([]);const service=createBillingService({client,accountId:A});
 for(const operation of [()=>service.summary(B),()=>service.ledger(B),()=>service.accounts(),()=>service.players(A),()=>service.createCharge({}),()=>service.recordReceipt({})]) await assert.rejects(operation,{code:"access_denied"});
 assert.equal(client.calls.length,0);
});
test("foreign-account response and malformed money fail closed",async()=>{
 for(const result of [data(balance(B)),data({...balance(),balance:"NaN"})]) await assert.rejects(()=>createBillingService({client:fake([result]),accountId:A}).summary());
 await assert.rejects(()=>createBillingService({client:fake([data([row(B)])]),accountId:A}).ledger());
 for(const value of ["1e2","1.001","Infinity","","0.001"])assert.throws(()=>billingCents(value));
});
test("revocation during delayed query discards private response",async()=>{
 let resolve;let current=true;const gate=new Promise((r)=>resolve=r);const client=fake([()=>gate]);
 const service=createBillingService({client,accountId:A,admin:true,isCurrent:()=>current});const promise=service.summary();current=false;resolve(data(balance()));await assert.rejects(()=>promise,{code:"stale_request"});
});
test("administrator pages accounts and balances only for shown account IDs",async()=>{
 const client=fake([data([{id:A,email:"a@example.com",display_name:"A"},{id:B,email:"b@example.com",display_name:"B"}]),data([balance(A),balance(B)])]);
 const result=await createBillingService({client,accountId:A,admin:true}).accounts();assert.equal(result.rows.length,2);assert.equal(result.rows[1].email,"b@example.com");
 assert.deepEqual(client.calls[1].ops.find((op)=>op[0]==="in"),["in","account_id",[A,B]]);
});
test("admin cannot allocate charge to an unrelated player",async()=>{
 const client=fake([data({id:P,payer_account_id:B})]);
 await assert.rejects(()=>createBillingService({client,accountId:A,admin:true}).createCharge({accountId:A,playerId:P,requestId:R,description:"Dues",amount:"100",date:"2026-10-01"}),{code:"invalid_entry"});assert.equal(client.calls.length,1);
});
test("receipt requires explicit review and date; member input never selects recorder or method",async()=>{
 const client=fake([(call)=>data({...call.ops.find((op)=>op[0]==="insert")[1],amount:100})]);const service=createBillingService({client,accountId:A,admin:true});
 const input={accountId:B,requestId:R,amount:"100",date:"2026-10-01",reference:"SYNTHETIC-REF",confirmed:true,recorded_by:B,method:"venmo"};
 await assert.rejects(()=>service.recordReceipt({...input,confirmed:false}),{code:"invalid_entry"});
 const result=await service.recordReceipt(input);assert.equal(result.recorded_by,A);assert.equal(result.method,"zelle");
});
test("uncertain receipt retries same ID and reconciles duplicate without inserting a second fact",async()=>{
 let saved;const client=fake([(call)=>{saved=call.ops.find((op)=>op[0]==="insert")[1];throw Error("network uncertain");},{data:null,error:{code:"23505"}},()=>data({...saved,amount:100})]);
 const service=createBillingService({client,accountId:A,admin:true});const input={accountId:B,requestId:R,amount:"100",date:"2026-10-01",reference:"SYNTHETIC-REF",confirmed:true};
 await assert.rejects(()=>service.recordReceipt(input),{code:"save_unconfirmed"});
 await assert.rejects(()=>service.recordReceipt({...input,amount:"200"}),{code:"retry_changed"});
 assert.equal((await service.recordReceipt(input)).id,R);
});
test("same ID with a different stored receipt is never reported successful",async()=>{
 const client=fake([{data:null,error:{code:"23505"}},data({id:R,account_id:B,amount:999,method:"zelle",payment_date:"2026-10-01",external_ref:"other",recorded_by:A,note:"other"})]);
 await assert.rejects(()=>createBillingService({client,accountId:A,admin:true}).recordReceipt({accountId:B,requestId:R,amount:"100",date:"2026-10-01",reference:"SYNTHETIC",confirmed:true}),{code:"save_unconfirmed"});
});
function authSetup(extra={}) {const values=new Map();const storage={getItem:(k)=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:(k)=>values.delete(k)};const base={location:{origin:"http://localhost:8080",pathname:"/app/",hash:"#/sign-in",search:""},history:{replaceState(){}},storage,locks:null,providerOrigin:"https://project.supabase.co",...extra};return {base,values,flow:createAuthFlow(base)};}
test("Google uses the existing PKCE return-state and callback exchange",async()=>{
 const {base,flow}=authSetup();let options;
 const client={auth:{signInWithOAuth:async(o)=>{options=o;return data({url:"https://project.supabase.co/auth/v1/authorize?provider=google"});}}};
 assert.match((await flow.requestGoogle(client,"#/billing")).url,/supabase/);assert.equal(options.provider,"google");assert.equal(options.options.skipBrowserRedirect,true);assert.equal(options.options.scopes,"openid email profile");
 const callback=createAuthFlow({...base,location:{...base.location,search:"?code=synthetic-code"}});
 const result=await callback.completeCallback({auth:{exchangeCodeForSession:async()=>data({session:{user:{id:A},access_token:"synthetic"}})}});
 assert.equal(result.returnTo,"#/billing");assert.equal(result.error,undefined);
});
test("Google rejects wrong auth origins and provider-controlled redirect responses",async()=>{
 for(const url of ["https://evil.example/auth/v1/authorize?provider=google","https://project.supabase.co/auth/v1/authorize?provider=github","https://user:pass@project.supabase.co/auth/v1/authorize?provider=google","javascript:alert(1)"]){const {flow}=authSetup();await assert.rejects(()=>flow.requestGoogle({auth:{signInWithOAuth:async()=>data({url})}}));}
 const {flow}=authSetup({location:{origin:"https://evil.example",pathname:"/app/"}});await assert.rejects(()=>flow.requestGoogle({auth:{signInWithOAuth(){throw Error("should not call");}}}),{code:"unsupported_origin"});
});
