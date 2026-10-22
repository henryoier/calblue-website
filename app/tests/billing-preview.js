import { billingView } from "../views/billing.js";
const id="11111111-1111-4111-8111-111111111111";
let controller,cleanup;
const service={
  accounts:async()=>({rows:[{id,email:"demo.player@example.com",display_name:"Demo Player",balance:75}],hasMore:false}),
  summary:async()=>({charges_total:100,payments_total:25,balance:75}),
  ledger:async()=>({rows:[{entry_date:"2026-10-15",description:"Zelle receipt reviewed by club administrator",entry_type:"zelle",direction:"payment",amount:-25},{entry_date:"2026-10-01",description:"Fall season dues · example",entry_type:"season_dues",direction:"charge",amount:100}],hasMore:false}),
  players:async()=>[{id:"22222222-2222-4222-8222-222222222222",display_name:"Demo Player",legal_name:"Example Player",date_of_birth:"1995-02-28",preferred_number:8,verification_status:"verified"}],
  createCharge:async()=>{throw Object.assign(Error("Preview only"),{code:"access_denied"});},
  recordReceipt:async()=>{throw Object.assign(Error("Preview only"),{code:"access_denied"});},
};
const main=document.querySelector("#preview");
new MutationObserver(()=>main.querySelectorAll("form button[type=submit]").forEach((button)=>button.disabled=true)).observe(main,{childList:true,subtree:true});
function show(admin) { cleanup?.();controller?.abort();controller=new AbortController();const signal=controller.signal;cleanup=billingView(main,{service,accountId:id,admin,context:{signal,isCurrent:()=>!signal.aborted}}); }
document.querySelector("#member").onclick=()=>show(false);document.querySelector("#admin").onclick=()=>show(true);show(false);
