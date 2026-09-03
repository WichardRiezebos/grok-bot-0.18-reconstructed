import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const REGISTRY_BEFORE = 'const wDn=[{id:"general",label:"General",icon:"settings-gear"},{id:"usage",label:"Usage & Billing",icon:"chart-bars"},{id:"beta",label:"Updates",icon:"cloud-download"}]';
const REGISTRY_AFTER = 'const wDn=[{id:"general",label:"General",icon:"settings-gear"},{id:"router",label:"Router",icon:"git-branch"},{id:"usage",label:"Usage & Billing",icon:"chart-bars"},{id:"beta",label:"Updates",icon:"cloud-download"}]';
const GENERAL_BEFORE = 'Q=x==="general"?a.jsx(Te,{children:a.jsx(Sa,{auth:t})}):null';
const GENERAL_AFTER = 'Q=x==="general"?a.jsx(Te,{children:a.jsx(Sa,{auth:t})}):x==="router"?a.jsx(RRouterPanel,{}):null';
const USAGE_BEFORE = 'Z=x==="usage"?a.jsx(Te,{children:a.jsx(Na,{})}):null';
const USAGE_AFTER = 'Z=x==="usage"?a.jsx(Te,{children:a.jsx(RRouterUsage,{})}):null';
const COMPONENT_ANCHOR = 'function Sa(s){';
const COMPONENT_SOURCE = String.raw`
const RRouterProviders=[
  {value:"openrouter",label:"OpenRouter",description:"Route through your OpenRouter account and selected model.",kind:"key",secret:"OPENROUTER_API_KEY"}
],RRouterComposio={value:"composio",label:"Composio",description:"Connect plugins through Composio. Paste a Connect key (ck_…) or a project API key (ak_…).",kind:"key",secret:"COMPOSIO_API_KEY"},RRouterOptions=RRouterProviders.map(s=>({value:s.value,label:s.label})),RRouterEmptyUsage={requests:0,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,costUsd:0,lastUsedAt:null},RRouterEffortOptions=[{value:"none",label:"None"},{value:"minimal",label:"Minimal"},{value:"low",label:"Low"},{value:"medium",label:"Medium"},{value:"high",label:"High"},{value:"xhigh",label:"Extra high"}],RRouterInputClass="sand-9f619 sand-h8yej3 sand-5f5z56 sand-u97haq sand-lrnmfh sand-uve7l6 sand-16b7oty sand-1rgtt3y sand-o7x2bt sand-mkeg23 sand-1y0btm7 sand-qz0629 sand-1043rbw sand-13l7odt sand-1wd3ewq sand-jb2p0i sand-4z9k3i sand-frs9s4 sand-tt52l0 sand-1odjw0f sand-1t137rt sand-ltfok3";
function RInputValue(s){const t=s?.target??s?.currentTarget;return typeof t?.value==="string"?t.value:""}
function RRouterState(){
  const z=H.c(4);
  const[s,e]=de.useState({provider:"openrouter",model:"x-ai/grok-4.6",computerModel:null,summarizeModel:null,reasoningEffort:"medium",computerReasoningEffort:"low",usage:null,local:null,error:null});
  de.useEffect(()=>{let t=!0;const n=r=>{t&&e(r.detail)};window.addEventListener("sand-router-provider-changed",n);window.desktop.agent.getInferenceRouter().then(r=>{t&&e({...r,provider:"openrouter",error:null})}).catch(r=>{t&&e(i=>({...i,error:String(r?.message??r)}))});return()=>{t=!1;window.removeEventListener("sand-router-provider-changed",n)}},[]);
  const t=async n=>{const r=s;e(i=>({...i,provider:"openrouter",error:null}));try{const i=await window.desktop.agent.setInferenceRouter("openrouter"),o={...i,provider:"openrouter",error:null};e(o);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:o}))}catch(i){e({...r,error:String(i?.message??i)})}};
  const n=async r=>{const i=s;e(o=>({...o,model:r,error:null}));try{const o=await window.desktop.agent.setInferenceRouter(s.provider,{model:r}),l={...o,error:null};e(l);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:l}))}catch(o){e({...i,error:String(o?.message??o)})}};
  const c=async r=>{const i=s;e(o=>({...o,computerModel:r,error:null}));try{const o=await window.desktop.agent.setInferenceRouter(s.provider,{computerModel:r}),l={...o,error:null};e(l);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:l}))}catch(o){e({...i,error:String(o?.message??o)})}};
  const g=async r=>{const i=s;e(o=>({...o,summarizeModel:r,error:null}));try{const o=await window.desktop.agent.setInferenceRouter(s.provider,{summarizeModel:r}),l={...o,error:null};e(l);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:l}))}catch(o){e({...i,error:String(o?.message??o)})}};
  const d=async r=>{const i=s;e(o=>({...o,reasoningEffort:r,error:null}));try{const o=await window.desktop.agent.setInferenceRouter(s.provider,{reasoningEffort:r}),l={...o,error:null};e(l);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:l}))}catch(o){e({...i,error:String(o?.message??o)})}};
  const p=async r=>{const i=s;e(o=>({...o,computerReasoningEffort:r,error:null}));try{const o=await window.desktop.agent.setInferenceRouter(s.provider,{computerReasoningEffort:r}),l={...o,error:null};e(l);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:l}))}catch(o){e({...i,error:String(o?.message??o)})}};
  const h=async r=>{const packs={high:{model:"anthropic/claude-opus-4.6",computerModel:"anthropic/claude-opus-4.6",summarizeModel:"google/gemini-2.5-flash",reasoningEffort:"medium",computerReasoningEffort:"low"},med:{model:"x-ai/grok-4.6",computerModel:"anthropic/claude-sonnet-4.6",summarizeModel:"google/gemini-2.5-flash",reasoningEffort:"medium",computerReasoningEffort:"low"},low:{model:"google/gemini-3.7-flash",computerModel:"anthropic/claude-haiku-4.5",summarizeModel:"qwen/qwen3.8-flash",reasoningEffort:"low",computerReasoningEffort:"low"}};const pack=packs[r];if(pack==null)return;const i=s;e(o=>({...o,...pack,error:null}));try{const o=await window.desktop.agent.setInferenceRouter(s.provider,pack),l={...o,error:null};e(l);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:l}))}catch(o){e({...i,error:String(o?.message??o)})}};
  return[s,t,n,c,d,p,g,h]
}
function RRouterSecrets(){const z=H.c(4);const[s,e]=de.useState([]),[t,n]=de.useState(0);de.useEffect(()=>{let r=!0;window.desktop.secrets.list().then(i=>{r&&e(Array.isArray(i?.keys)?i.keys:[])});return()=>{r=!1}},[t]);return[s,()=>n(r=>r+1)]}
function RRouterNumber(s){return new Intl.NumberFormat().format(s)}
function RRouterCredential({provider:s,state:e,keys:t,onSaved:n}){const z=H.c(8);const[r,i]=de.useState(""),[o,l]=de.useState(!1),[u,m]=de.useState(null);if(s.kind==="account")return a.jsx(se,{as:"span",color:"secondary",size:"sm",children:"Signed in"});if(s.kind==="local"){const c=e.local?.[s.localKey],d=c?.installed&&c?.authenticated;return a.jsx(se,{as:"span",color:d?"primary":"secondary",size:"sm",children:d?"Ready":c?.installed?"Sign in with "+(s.value==="codex"?"codex login":"claude"):"Not installed"})}const c=t.includes(s.secret),d=async()=>{if(r.trim().length===0)return;l(!0);m(null);try{const p=await window.desktop.secrets.upsert({[s.secret]:r.trim()});if(p?.synced===false)throw new Error("The key was saved on this Mac, but Grok Bot's computer did not receive it. Wait until the computer is running, then Save again.");i("");n()}catch(p){m(REdgeError(p))}finally{l(!1)}};return a.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-6s0dn4 sand-h8yej3",style:{width:360},children:[a.jsx("input",{"aria-label":s.secret,className:RRouterInputClass,disabled:o,onChange:v=>i(RInputValue(v)),placeholder:c?"Replace saved key":"Paste API key",style:{fontSize:13,height:34,minWidth:0,padding:"0 10px",width:270},type:"password",value:r}),a.jsx(oe,{disabled:o||r.trim().length===0,onClick:d,shape:"rectangular",size:"sm",variant:"secondary",children:o?"Saving…":"Save"}),u?a.jsx(se,{as:"p",color:"red",size:"sm",children:u}):null]})}
function RRouterMoney(s){const t=typeof s==="number"&&Number.isFinite(s)&&s>0?s:0;return new Intl.NumberFormat(undefined,{style:"currency",currency:"USD",minimumFractionDigits:2,maximumFractionDigits:4}).format(t)}
function RRouterUsageRows({usage:s}){return a.jsxs("div",{children:[a.jsx(ie,{label:"Spend",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterMoney(s.costUsd)})}),a.jsx(ie,{divided:!0,label:"Requests",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.requests)})}),a.jsx(ie,{divided:!0,label:"Input tokens",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.inputTokens)})}),a.jsx(ie,{divided:!0,label:"Output tokens",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.outputTokens)})}),a.jsx(ie,{divided:!0,label:"Cache tokens",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.cacheReadTokens+s.cacheWriteTokens)})}),a.jsx(ie,{divided:!0,label:"Last used",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:s.lastUsedAt?new Date(s.lastUsedAt).toLocaleString():"Not used yet"})})]})}
function REmailLooksValid(s){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s??"").trim())}
function RInitials(s){const t=String(s??"").trim();if(t.length===0)return"G";const n=t.split(/\s+/).filter(Boolean);return((n[0]?.[0]??"")+(n[1]?.[0]??"")).toUpperCase()}
async function RGravatarUrl(s){const t=String(s??"").trim().toLowerCase();if(!REmailLooksValid(t))return null;const n=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(t)),r=[...new Uint8Array(n)].map(i=>i.toString(16).padStart(2,"0")).join("");return"https://www.gravatar.com/avatar/"+r+"?s=160&d=identicon&r=g"}
function RLocalProfile(){const z=H.c(8);const[s,e]=de.useState({name:"Local",email:"",gravatarUrl:null,draftName:"Local",draftEmail:"",previewUrl:"",busy:!1,saved:!1,error:""});de.useEffect(()=>{let t=!0;(window.desktop.agent.getLocalProfile?window.desktop.agent.getLocalProfile():Promise.resolve({name:"Local",email:"",gravatarUrl:null})).then(n=>{if(!t)return;const d=typeof n?.name==="string"&&n.name.trim().length>0?n.name:"Local",g=typeof n?.email==="string"?n.email:"";e(r=>({...r,name:d,email:g,gravatarUrl:n?.gravatarUrl??null,draftName:d,draftEmail:g,previewUrl:typeof n?.gravatarUrl==="string"?n.gravatarUrl:""}))}).catch(n=>{t&&e(r=>({...r,error:REdgeError(n)}))});return()=>{t=!1}},[]);de.useEffect(()=>{let t=!0;if(!REmailLooksValid(s.draftEmail)){e(n=>({...n,previewUrl:""}));return}RGravatarUrl(s.draftEmail).then(n=>{t&&e(r=>({...r,previewUrl:typeof n==="string"?n:""}))});return()=>{t=!1}},[s.draftEmail]);const n=s.draftName!==s.name||s.draftEmail!==s.email,r=async()=>{if(s.draftEmail.trim().length>0&&!REmailLooksValid(s.draftEmail)){e(i=>({...i,error:"Enter a valid email, or leave it blank."}));return}e(i=>({...i,busy:!0,saved:!1,error:""}));try{await window.desktop.agent.setLocalProfile({name:s.draftName,email:s.draftEmail});const i=await (window.desktop.agent.getLocalProfile?window.desktop.agent.getLocalProfile():Promise.resolve({name:s.draftName,email:s.draftEmail,gravatarUrl:s.previewUrl}));const d=typeof i?.name==="string"&&i.name.trim().length>0?i.name:s.draftName,g=typeof i?.email==="string"?i.email:s.draftEmail,p=typeof i?.gravatarUrl==="string"?i.gravatarUrl:(typeof s.previewUrl==="string"?s.previewUrl:"");e(o=>({...o,name:d,email:g,gravatarUrl:p||null,draftName:d,draftEmail:g,previewUrl:p,busy:!1,saved:!0,error:""}))}catch(i){e(o=>({...o,busy:!1,error:REdgeError(i)}))}};return a.jsxs("div",{children:[a.jsx(ie,{description:"Shown in the sidebar. Add an email to load your Gravatar, or an identicon if you do not have one yet.",label:"Profile",variant:"card",children:a.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-6s0dn4",style:{alignItems:"center",gap:14,width:360},children:[a.jsx("div",{"aria-hidden":!0,style:{background:"linear-gradient(160deg,rgba(79,140,255,.38),rgba(255,255,255,.08))",border:"1px solid rgba(255,255,255,.14)",borderRadius:"50%",boxShadow:"0 0 0 3px rgba(79,140,255,.16)",flex:"0 0 auto",height:64,overflow:"hidden",width:64},children:s.previewUrl?a.jsx("img",{alt:"",referrerPolicy:"no-referrer",src:s.previewUrl,style:{display:"block",height:"100%",objectFit:"cover",width:"100%"}}):a.jsx("div",{style:{alignItems:"center",color:"rgba(255,255,255,.94)",display:"flex",fontSize:22,fontWeight:600,height:"100%",justifyContent:"center",letterSpacing:".04em"},children:RInitials(s.draftName)})}),a.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-dt5ytf",style:{gap:2,minWidth:0},children:[a.jsx(se,{as:"span",size:"sm",children:(s.draftName??"").trim()||"Local"}),a.jsx(se,{as:"span",color:"secondary",size:"sm",children:REmailLooksValid(s.draftEmail)?"Gravatar preview":"Add an email to show your Gravatar"})]})]})}),a.jsx(ie,{divided:!0,description:"How you appear in the account menu.",label:"Name",variant:"card",children:a.jsx("div",{style:{width:360},children:a.jsx("input",{"aria-label":"Display name",className:RRouterInputClass,onChange:i=>e(o=>({...o,draftName:RInputValue(i),saved:!1})),placeholder:"Your name",style:{fontSize:13,height:34,minWidth:0,padding:"0 10px",width:"100%"},value:s.draftName??""})})}),a.jsx(ie,{divided:!0,description:"Used only to fetch your Gravatar. Nothing is sent to Cursor.",label:"Email",variant:"card",children:a.jsx("div",{style:{width:360},children:a.jsx("input",{"aria-label":"Profile email",autoComplete:"email",className:RRouterInputClass,onChange:i=>e(o=>({...o,draftEmail:RInputValue(i),saved:!1})),placeholder:"you@example.com",style:{fontSize:13,height:34,minWidth:0,padding:"0 10px",width:"100%"},type:"email",value:s.draftEmail??""})})}),a.jsx(ie,{divided:!0,description:"Save updates the sidebar name and avatar in this app.",label:" ",variant:"card",children:a.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-6s0dn4",style:{gap:10,width:360},children:[a.jsx(oe,{disabled:s.busy||!n,onClick:r,shape:"rectangular",size:"sm",variant:"secondary",children:s.busy?"Saving…":s.saved?"Saved":"Save profile"}),a.jsx("button",{onClick:()=>{void window.desktop.openExternal("https://gravatar.com")},style:{background:"transparent",border:0,color:"inherit",cursor:"pointer",padding:0},type:"button",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:"Edit on Gravatar"})})]})}),s.error?a.jsx(se,{as:"p",color:"red",size:"sm",children:s.error}):null]})}
function REdgeError(s){const t=typeof s?.detail==="string"&&s.detail.length>0?s.detail:s?.message??s,n=String(t);return n.startsWith("edge/handler-failed: ")?n.slice("edge/handler-failed: ".length):n}
function RRouterModelId(s){return String(s??"").replace(/^~+/,"");}
function RRouterModelMatches(s,e){const t=s.trim().toLowerCase();if(t.length===0)return!0;return e.id.toLowerCase().includes(t)||e.name.toLowerCase().includes(t)}
function RRouterOpenRouterModels({provider:s,model:e,onChange:t,label:n="Model",description:r,ariaLabel:i="OpenRouter model",inherit:o=!1}){const z=H.c(8);const[l,u]=de.useState({models:[],error:null,busy:!0}),[q,j]=de.useState("");de.useEffect(()=>{if(s!=="openrouter")return;let m=!0;u({models:[],error:null,busy:!0});window.desktop.agent.listOpenRouterModels().then(c=>{if(!m)return;u({models:Array.isArray(c?.models)?c.models:[],error:typeof c?.error==="string"?c.error:null,busy:!1})}).catch(c=>{m&&u(d=>({...d,error:REdgeError(c),busy:!1}))});return()=>{m=!1}},[s]);if(s!=="openrouter")return null;const selected=e==null||e==="__inherit__"?"":RRouterModelId(e),all=l.models??[],query=q.trim(),matched=query.length===0?all.filter(c=>c.recommended||c.id===selected):all.filter(c=>RRouterModelMatches(query,c)),shown=matched.slice(0,80),m=shown.map(c=>({value:c.id,label:c.recommended?"Recommended · "+c.name:c.name+" · "+c.id}));if(selected&&!m.some(p=>p.value===selected))m.unshift({value:selected,label:selected});const c=o?[{value:"__inherit__",label:"Same as Think"},...m]:m,d=e==null||e==="__inherit__"?o?"__inherit__":(c[0]?.value??selected):c.some(p=>p.value===selected)?selected:(c[0]?.value??selected),hint=l.busy?"Loading models from OpenRouter.":query.length===0?r:shown.length===0?"No models match that search.":shown.length<matched.length?"Showing "+shown.length+" of "+matched.length+" matches.":r;return a.jsx(ie,{divided:!0,description:hint,label:n,variant:"card",children:l.error&&c.length===(o?1:0)?a.jsx(se,{as:"span",color:"red",size:"sm",children:l.error}):a.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-dt5ytf",style:{gap:8,width:360},children:[a.jsx("input",{"aria-label":i+" search",className:RRouterInputClass,onChange:v=>j(RInputValue(v)),placeholder:"Search models",style:{fontSize:13,height:34,minWidth:0,padding:"0 10px",width:"100%"},value:q}),a.jsx(ye,{"aria-label":i,onValueChange:p=>{if(p!==null)void t(p==="__inherit__"?null:RRouterModelId(p))},options:c.length>0?c:[{value:d||"__none__",label:d||"No models"}],placement:"bottom-end",size:"lg",value:d||(c[0]?.value??"__none__"),variant:"filled"})]})})}
function RRouterEffort({provider:s,value:e,onChange:t,label:n,description:r,ariaLabel:i,fallback:o}){if(s!=="openrouter")return null;const l=RRouterEffortOptions.some(u=>u.value===e)?e:o;return a.jsx(ie,{divided:!0,description:r,label:n,variant:"card",children:a.jsx(ye,{"aria-label":i,onValueChange:u=>{if(u!==null)void t(u)},options:RRouterEffortOptions,placement:"bottom-end",size:"lg",value:l,variant:"filled"})})}
function RIsDocker(){const z=H.c(4);const[s,e]=de.useState(!1);de.useEffect(()=>{let t=!0;(window.desktop.agent.getDesktopEnvironment?window.desktop.agent.getDesktopEnvironment():Promise.resolve(null)).then(n=>{t&&e(n&&n.runtime==="docker")}).catch(()=>{});return()=>{t=!1}},[]);return s}
function RBoxIdleOptions(){return[{value:"0",label:"Off"},{value:String(15*60*1e3),label:"15 minutes"},{value:String(30*60*1e3),label:"30 minutes"},{value:String(60*60*1e3),label:"1 hour"},{value:String(2*60*60*1e3),label:"2 hours"}]}
function RBoxRuntime(){const z=H.c(8);const docker=RIsDocker();const[s,e]=de.useState({mode:"local-docker",status:null,idleMs:30*60*1e3,suspended:!1,error:null,busy:!0,acting:null});const n=()=>window.desktop.agent.getBoxRuntime().then(r=>{e(i=>({...i,...r,error:null,busy:!1}))}).catch(r=>{e(i=>({...i,error:REdgeError(r),busy:!1}))});de.useEffect(()=>{let t=!0;n();const p=setInterval(()=>{t&&n()},2e3);return()=>{t=!1;clearInterval(p)}},[]);const running=s.status?.ready||s.status?.running,sleeping=s.suspended===!0||!running&&s.idleMs>0,label=docker?"Owned by this web runtime":s.acting==="wake"?"Starting":s.busy?"Checking…":s.status?.available===!1?"Docker unavailable":sleeping?"Sleeping":running?"Running":"Not running",hint=docker?"Shell, files and computer use run in the Compose box service.":sleeping?"The local Docker VM is stopped until you wake it or send a message.":(s.status?.detail??"Shell, files and computer use run in a local Docker VM on this Mac.");const idleValue=String(typeof s.idleMs==="number"?s.idleMs:30*60*1e3);const act=async(kind,work)=>{e(i=>({...i,acting:kind,error:null}));try{const r=await work();e(i=>({...i,...r,acting:null,busy:!1,error:null}))}catch(r){e(i=>({...i,acting:null,error:REdgeError(r)}))}};return a.jsxs("div",{children:[a.jsx(ie,{description:hint,label:"Computer",variant:"card",children:a.jsx(se,{as:"span",color:running&&!sleeping?"primary":"secondary",size:"sm",children:label})}),docker?null:a.jsx(ie,{divided:!0,description:"Stops the local Docker VM after this much idle time so it is not using CPU and RAM. Sending a message or clicking Wake starts it again.",label:"Auto-suspend",variant:"card",children:a.jsx(ye,{"aria-label":"Auto-suspend idle time",onValueChange:r=>{if(r!==null)void act("idle",()=>window.desktop.agent.setBoxAutoSuspendIdleMs(Number(r)))},options:RBoxIdleOptions(),placement:"bottom-end",size:"lg",value:idleValue,variant:"filled"})}),docker?null:a.jsx(ie,{divided:!0,description:"Sleep stops the VM now. Wake starts it again. Files and logins stay on the Docker volumes.",label:"Power",variant:"card",children:a.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-6s0dn4",style:{gap:8,width:360},children:[a.jsx(oe,{disabled:s.acting!=null||sleeping||!running,onClick:()=>void act("sleep",()=>window.desktop.agent.suspendBox()),shape:"rectangular",size:"sm",variant:"secondary",children:s.acting==="sleep"?"Sleeping…":"Sleep now"}),a.jsx(oe,{disabled:s.acting!=null||running&&!sleeping,onClick:()=>void act("wake",()=>window.desktop.agent.resumeBox()),shape:"rectangular",size:"sm",variant:"secondary",children:s.acting==="wake"?"Waking…":"Wake"})]})}),s.error?a.jsx(se,{as:"p",color:"red",size:"sm",children:s.error}):null]})}
function RRouterPresets({onApply:s}){return a.jsx(ie,{description:"Write Think, Drive, and Summarize together.",label:"Preset",variant:"card",children:a.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-6s0dn4",style:{gap:8,width:360},children:[a.jsx(oe,{onClick:()=>void s("high"),shape:"rectangular",size:"sm",variant:"secondary",children:"High"}),a.jsx(oe,{onClick:()=>void s("med"),shape:"rectangular",size:"sm",variant:"secondary",children:"Med"}),a.jsx(oe,{onClick:()=>void s("low"),shape:"rectangular",size:"sm",variant:"secondary",children:"Low"})]})})}
function RRouterPanel(){const z=H.c(2);const[s,,t,n,c,d,g,h]=RRouterState(),[r,i]=RRouterSecrets(),o=RRouterProviders[0],l=s.usage?.providers?.openrouter??RRouterEmptyUsage;return a.jsx(Te,{children:a.jsxs("div",{className:k("sand-settings-general","sand-9f619 sand-78zum5 sand-dt5ytf sand-3qzy4x"),children:[a.jsx(re,{title:"You",children:a.jsx(RLocalProfile,{})}),a.jsx(re,{title:"Routing",children:a.jsxs("div",{children:[a.jsx(ie,{description:o.description,label:"Provider",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:"OpenRouter"})}),a.jsx(RRouterPresets,{onApply:h}),a.jsx(RRouterOpenRouterModels,{provider:"openrouter",model:s.model??"x-ai/grok-4.6",onChange:t,label:"Think model",description:"Used for chat and turns that do not need the screen.",ariaLabel:"OpenRouter think model"}),a.jsx(RRouterEffort,{provider:"openrouter",value:s.reasoningEffort??"medium",onChange:c,label:"Think reasoning",description:"Thinking effort for chat and turns that do not need the screen.",ariaLabel:"OpenRouter think reasoning effort",fallback:"medium"}),a.jsx(RRouterOpenRouterModels,{provider:"openrouter",model:s.computerModel??"anthropic/claude-sonnet-4.6",onChange:n,label:"Drive model",description:"Used when the agent needs the box screen. Screen and click stay on this one model.",ariaLabel:"OpenRouter drive model"}),a.jsx(RRouterEffort,{provider:"openrouter",value:s.computerReasoningEffort??"low",onChange:d,label:"Drive reasoning",description:"Thinking effort while driving the box screen. Low keeps clicks fast.",ariaLabel:"OpenRouter drive reasoning effort",fallback:"low"}),a.jsx(RRouterOpenRouterModels,{provider:"openrouter",model:s.summarizeModel??"__inherit__",onChange:g,label:"Summarize model",description:"Used to compress long transcripts. Same as Think when unset.",ariaLabel:"OpenRouter summarize model",inherit:!0})]})}),a.jsx(re,{title:"Computer",children:a.jsx(RBoxRuntime,{})}),a.jsx(re,{title:"OpenRouter account",children:a.jsx(ie,{description:"Stored securely with your other Grok Bot secrets.",label:"API key",variant:"card",children:a.jsx(RRouterCredential,{provider:o,state:s,keys:r,onSaved:i})})}),a.jsx(re,{title:"Composio",children:a.jsx(ie,{description:"Connect keys start with ck_. Project keys start with ak_ and use your dashboard Gmail (and other) connections. Stored securely with your other secrets.",label:"API key",variant:"card",children:a.jsx(RRouterCredential,{provider:RRouterComposio,state:s,keys:r,onSaved:i})})}),s.error?a.jsx(se,{as:"p",color:"red",size:"sm",children:s.error}):null,a.jsx(re,{title:"Usage for OpenRouter",children:a.jsx(RRouterUsageRows,{usage:l})})]})})}
function RRouterUsageSummary({provider:s,usage:e,current:t,divided:n}){const r=[RRouterMoney(e.costUsd)+" spend",RRouterNumber(e.requests)+" requests",RRouterNumber(e.inputTokens)+" input",RRouterNumber(e.outputTokens)+" output",RRouterNumber(e.cacheReadTokens+e.cacheWriteTokens)+" cached"].join(" · "),i=t?"Current route":e.lastUsedAt?new Date(e.lastUsedAt).toLocaleString():"Not used yet";return a.jsx(ie,{divided:n,description:r,label:s.label,variant:"card",children:a.jsx(se,{as:"span",color:t?"primary":"secondary",size:"sm",children:i})})}
function RRouterUsage(){const z=H.c(2);const[s]=RRouterState(),e=RRouterProviders[0],t=s.usage?.providers?.openrouter??RRouterEmptyUsage;return a.jsxs("div",{className:k("sand-usage-section","sand-9f619 sand-78zum5 sand-dt5ytf sand-ou54vl"),children:[a.jsx(re,{title:"Current provider",children:a.jsx(ie,{description:e.description,label:e.label,variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:"OpenRouter"})})}),a.jsx(re,{title:"Tracked activity",children:a.jsx(RRouterUsageRows,{usage:t})})]})}
`;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + 1) >= 0) throw new Error(`Original renderer ${label} anchor is missing or ambiguous.`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

export function patchOriginalSettingsRegistry(source) {
  return replaceExactlyOnce(source, REGISTRY_BEFORE, REGISTRY_AFTER, "settings registry");
}

const HGN_BEFORE = 'function Hgn(n){switch(n){case"slack":return{platform:"slack"';
const HGN_AFTER = 'function Hgn(n){switch(n){case"composio":return{platform:"composio",triggerSlug:"GMAIL_NEW_GMAIL_MESSAGE"};case"slack":return{platform:"slack"';
const VGN_BEFORE = 'case"pagerduty":return{platform:"pagerduty",event:n.event.case,serviceIds:n.serviceIds.join(", ")}}}';
const VGN_AFTER = 'case"pagerduty":return{platform:"pagerduty",event:n.event.case,serviceIds:n.serviceIds.join(", ")};case"composio":return{platform:"composio",triggerSlug:typeof n.triggerSlug==="string"?n.triggerSlug:"GMAIL_NEW_GMAIL_MESSAGE"}}}';
const GGN_BEFORE = 'function Ggn(n){if(n.platform==="slack"){';
const GGN_AFTER = 'function Ggn(n){if(n.platform==="composio"){const i=String(n.triggerSlug??"").trim();return i.length===0?null:{type:"composio",triggerSlug:i}}if(n.platform==="slack"){';
const C2N_BEFORE = 'function C2n(n){switch(n){case"slack":';
const C2N_AFTER = 'function C2n(n){switch(n){case"composio":return p.jsx(Dr,{name:"mail",size:"md"});case"slack":';
const X2N_BEFORE = 'function x2n(n){switch(n.platform){case"slack":';
const X2N_AFTER = 'function x2n(n){switch(n.platform){case"composio":return n.triggerSlug==="GMAIL_NEW_GMAIL_MESSAGE"?{lead:"New",rest:"Gmail messages"}:{lead:"When",rest:"Composio "+n.triggerSlug+" fires"};case"slack":';
const F2N_BEFORE = 'function f2n(n){const e=he.c(24),{listener:t,onChange:s,onCommit:r}=n;switch(t.platform){case"slack":';
const F2N_AFTER = 'function f2n(n){const e=he.c(24),{listener:t,onChange:s,onCommit:r}=n;switch(t.platform){case"composio":return p.jsx("span",{children:t.triggerSlug==="GMAIL_NEW_GMAIL_MESSAGE"?"New Gmail message":t.triggerSlug});case"slack":';
const MENU_BEFORE = 'p.jsx(It.Item,{leading:p.jsx(Yne,{name:"slack",sizePx:18}),onSelect:()=>F("slack"),children:"Slack message"})';
const MENU_AFTER = 'p.jsx(It.Item,{leading:p.jsx(Dr,{name:"mail",size:"md"}),onSelect:()=>F("composio"),children:"Gmail message"}),p.jsx(It.Item,{leading:p.jsx(Yne,{name:"slack",sizePx:18}),onSelect:()=>F("slack"),children:"Slack message"})';

export function patchOriginalRoutineTriggerPicker(source) {
  let patched = replaceExactlyOnce(source, HGN_BEFORE, HGN_AFTER, "composio trigger factory");
  patched = replaceExactlyOnce(patched, VGN_BEFORE, VGN_AFTER, "composio trigger load");
  patched = replaceExactlyOnce(patched, GGN_BEFORE, GGN_AFTER, "composio trigger save");
  patched = replaceExactlyOnce(patched, C2N_BEFORE, C2N_AFTER, "composio trigger glyph");
  patched = replaceExactlyOnce(patched, X2N_BEFORE, X2N_AFTER, "composio trigger sentence");
  patched = replaceExactlyOnce(patched, F2N_BEFORE, F2N_AFTER, "composio trigger fields");
  patched = replaceExactlyOnce(patched, MENU_BEFORE, MENU_AFTER, "composio trigger menu");
  return patched;
}

export function patchOriginalSettingsPanel(source) {
  let patched = replaceExactlyOnce(source, COMPONENT_ANCHOR, `${COMPONENT_SOURCE}${COMPONENT_ANCHOR}`, "component insertion");
  patched = replaceExactlyOnce(patched, GENERAL_BEFORE, GENERAL_AFTER, "Router panel switch");
  patched = replaceExactlyOnce(patched, USAGE_BEFORE, USAGE_AFTER, "Usage panel switch");
  return patched;
}

export async function applyOriginalRendererRouterPatch({ stageRoot }) {
  const assetsRoot = path.join(stageRoot, "dist", "renderer", "assets");
  if (await isO36Renderer(assetsRoot)) {
    return await applyO36RendererRouterPatch({ stageRoot });
  }
  return await applyLegacyRendererRouterPatch({ stageRoot });
}

async function isO36Renderer(assetsRoot) {
  for (const name of await readdir(assetsRoot)) {
    if (!name.endsWith(".js")) continue;
    const source = await readFile(path.join(assetsRoot, name), "utf8");
    if (source.includes('/src/electron-renderer/features/settings/overlay/usage/entrypoint.ts')) return true;
  }
  return false;
}

export async function applyLegacyRendererRouterPatch({ stageRoot }) {
  const assetsRoot = path.join(stageRoot, "dist", "renderer", "assets");
  const registryCandidates = [];
  const panelCandidates = [];
  for (const name of await readdir(assetsRoot)) {
    if (!name.endsWith(".js")) continue;
    const target = path.join(assetsRoot, name);
    const source = await readFile(target, "utf8");
    if (source.includes(REGISTRY_BEFORE)) registryCandidates.push({ name, target, source });
    if (source.includes(COMPONENT_ANCHOR) && source.includes(GENERAL_BEFORE) && source.includes(USAGE_BEFORE)) panelCandidates.push({ name, target, source });
  }
  if (registryCandidates.length !== 1 || panelCandidates.length !== 1) {
    throw new Error(`Expected one original Settings registry and panel chunk, found ${registryCandidates.length}/${panelCandidates.length}.`);
  }
  if (registryCandidates[0].target === panelCandidates[0].target) {
    throw new Error("Expected distinct original Settings registry and panel chunks.");
  }
  const changes = [];
  for (const [role, candidate, transform] of [
    ["registry", registryCandidates[0], (source) => patchOriginalRoutineTriggerPicker(patchOriginalSettingsRegistry(source))],
    ["panel", panelCandidates[0], patchOriginalSettingsPanel],
  ]) {
    const patched = transform(candidate.source);
    await writeFile(candidate.target, patched);
    changes.push({
      role,
      path: `dist/renderer/assets/${candidate.name}`,
      original: { bytes: Buffer.byteLength(candidate.source), sha256: sha256(candidate.source) },
      patched: { bytes: Buffer.byteLength(patched), sha256: sha256(patched) },
    });
  }
  const record = {
    schemaVersion: 1,
    mode: "original-renderer-settings-extension",
    chunks: changes,
    features: ["settings-router-provider", "settings-openrouter-model", "settings-openrouter-computer-model", "settings-openrouter-reasoning-effort", "settings-openrouter-model-search", "settings-local-docker-status", "settings-box-auto-suspend", "settings-composio", "settings-local-profile", "settings-gravatar", "usage-openrouter-cost", "routines-composio-gmail"],
    transformations: ["settings-registry", "router-panel", "usage-panel", "routines-composio-gmail"],
  };
  const provenancePath = path.join(stageRoot, "dist", "renderer-router-extension.json");
  await writeFile(provenancePath, `${JSON.stringify(record, null, 2)}\n`);
  return { ...record, provenancePath, provenanceBytes: (await stat(provenancePath)).size };
}

// ---------------------------------------------------------------------------
// Grok Bot 0.36.0 renderer patch (web/Dokploy runtime)
//
// The 0.36 settings surface moved from an inline panel switch to a catalog
// ("Dune") runtime: module-graph tables Gwt (entrypoint.ts declarations) and
// Hwt (lazy view.tsx loaders) in the main chunk, an entrypoint map y2, the
// settings registry array iC, and per-pane lazy chunks. The Router page is
// therefore integrated at the catalog level plus a dedicated view chunk, and
// the composio Gmail trigger is integrated into the shared trigger factories
// (defaults FMt, load iKe, save oKe, sentences WMt/OKe) and the automation
// editor chunk (menu, row glyph In, fields Cn).
// ---------------------------------------------------------------------------

const O36_CHUNK_VIEW_NAME = "chunk-view-router-patch1.js";

const O36_MAIN_Y2_IC_BEFORE = 'y2={general:P6,computer:hue,usage:gue,updates:pue},iC=[{id:"general",label:{id:"Weq9zb"},icon:"settings-gear",entrypoint:y2.general},{id:"computer",label:{id:"9lzViG"},icon:"display",entrypoint:y2.computer}';
const O36_MAIN_Y2_IC_AFTER = 'y2={general:P6,router:globalThis.__RR_ROUTER_E??(globalThis.__RR_ROUTER_E=Ec()),computer:hue,usage:gue,updates:pue},iC=[{id:"general",label:{id:"Weq9zb"},icon:"settings-gear",entrypoint:y2.general},{id:"router",label:{id:"Router"},icon:"git-branch",entrypoint:y2.router},{id:"computer",label:{id:"9lzViG"},icon:"display",entrypoint:y2.computer}';

const O36_MAIN_GWT_BEFORE = '"/src/electron-renderer/features/settings/overlay/computer/entrypoint.ts":Abt,';
const O36_MAIN_GWT_AFTER = '"/src/electron-renderer/features/settings/overlay/router/entrypoint.ts":Object.freeze(Object.defineProperty({__proto__:null,default:globalThis.__RR_ROUTER_E},Symbol.toStringTag,{value:"Module"})),' + O36_MAIN_GWT_BEFORE;

const O36_MAIN_HWT_BEFORE = '"/src/electron-renderer/features/settings/overlay/updates/view.tsx":()=>dt(()=>import("./chunk-view-C9jM-RLQ.js"),__vite__mapDeps([44,45,35,40]),import.meta.url),';
const O36_MAIN_HWT_AFTER = O36_MAIN_HWT_BEFORE + `"${"/src/electron-renderer/features/settings/overlay/router/view.tsx"}":()=>dt(()=>import("./${O36_CHUNK_VIEW_NAME}"),[],import.meta.url),`;

const O36_MAIN_BPT_BEFORE = 'const bpt={general:["account","model","notifications","preferences","appearance","theme","mode","color","accent","bot","chat","tint","security","yubikey","webauthn"]';
const O36_MAIN_BPT_AFTER = 'const bpt={router:["router","openrouter","model","models","spend"],general:["account","model","notifications","preferences","appearance","theme","mode","color","accent","bot","chat","tint","security","yubikey","webauthn"]';

const O36_MAIN_FMET_BEFORE = 'function FMt(t){switch(t){case"slack":return{platform:"slack"';
const O36_MAIN_FMET_AFTER = 'function FMt(t){switch(t){case"composio":return{platform:"composio",triggerSlug:"GMAIL_NEW_GMAIL_MESSAGE"};case"slack":return{platform:"slack"';

const O36_MAIN_IKE_BEFORE = 'function iKe(t){switch(t.type){case"cron":return{platform:"schedule",schedule:t.schedule};case"slack":';
const O36_MAIN_IKE_AFTER = 'function iKe(t){switch(t.type){case"cron":return{platform:"schedule",schedule:t.schedule};case"composio":return{platform:"composio",triggerSlug:typeof t.triggerSlug==="string"?t.triggerSlug:"GMAIL_NEW_GMAIL_MESSAGE"};case"slack":';

const O36_MAIN_OKE_SAVE_BEFORE = 'function oKe(t){if(t.platform==="slack"){';
const O36_MAIN_OKE_SAVE_AFTER = 'function oKe(t){if(t.platform==="composio"){const i=String(t.triggerSlug??"").trim();return i.length===0?null:{type:"composio",triggerSlug:i}}if(t.platform==="slack"){';

const O36_MAIN_WMT_BEFORE = 'function WMt(t,e){switch(e.platform){case"slack":return wKe(t,e);';
const O36_MAIN_WMT_AFTER = 'function WMt(t,e){switch(e.platform){case"composio":return e.triggerSlug==="GMAIL_NEW_GMAIL_MESSAGE"?"a new Gmail message arrives":"Composio "+e.triggerSlug+" fires";case"slack":return wKe(t,e);';

const O36_MAIN_OKET_BEFORE = 'function OKe(t,e){switch(e.type){case"slack":return jKe(t,e);';
const O36_MAIN_OKET_AFTER = 'function OKe(t,e){switch(e.type){case"composio":return e.triggerSlug==="GMAIL_NEW_GMAIL_MESSAGE"?"a new Gmail message arrives":"Composio "+e.triggerSlug+" fires";case"slack":return jKe(t,e);';

const O36_AUTO_MENU_BEFORE = 't.jsx(L.Item,{leading:t.jsx(et,{name:"slack",sizePx:18}),onSelect:()=>Z("slack"),children:t.jsx(T,{id:"bCu1pq"})})';
const O36_AUTO_MENU_AFTER = 't.jsx(L.Item,{leading:t.jsx(Ae,{name:"mail",size:"md"}),onSelect:()=>Z("composio"),children:"New Gmail message"}),' + O36_AUTO_MENU_BEFORE;

const O36_AUTO_GLYPH_BEFORE = 'function In(d){switch(d){case"slack":return t.jsx(et,{name:"slack",sizePx:16});';
const O36_AUTO_GLYPH_AFTER = 'function In(d){switch(d){case"composio":return t.jsx(Ae,{name:"mail",size:"md"});case"slack":return t.jsx(et,{name:"slack",sizePx:16});';

const O36_AUTO_FIELDS_BEFORE = 'function Cn(d){const e=B.c(26),{listener:s,webhookCredential:l,onChange:n,onCommit:a}=d;switch(s.platform){case"slack":';
const O36_AUTO_FIELDS_AFTER = 'function Cn(d){const e=B.c(26),{listener:s,webhookCredential:l,onChange:n,onCommit:a}=d;switch(s.platform){case"composio":return t.jsx("span",{children:s.triggerSlug==="GMAIL_NEW_GMAIL_MESSAGE"?"New Gmail message":s.triggerSlug});case"slack":';

const O36_SHELL_IMPORT_BEFORE = 'import{S as b}from"./chunk-general-pane-DVoy3ei1.js";';
const O36_SHELL_IMPORT_AFTER = `import{RRouterPanel as RRpanel}from"./${O36_CHUNK_VIEW_NAME}";` + O36_SHELL_IMPORT_BEFORE;

const O36_SHELL_IMAP_BEFORE = 'const I={general:b,computer:E,usage:N,updates:U};';
const O36_SHELL_IMAP_AFTER = 'const I={general:b,router:RRpanel,computer:E,usage:N,updates:U};';

const O36_ROUTER_VIEW_CHUNK = String.raw`import{j as RRj,r as RRr,ax as RRfocus,B as RRbt,aF as RRsel,O as RRtxt,w as RRcn}from"./index-Dl1Aho6j.js";
import{G as RRsec,a as RRrow}from"./chunk-settings-row-BGwCLXev.js";
import{S as RRscroll}from"./chunk-scroll-pane-LA3thSZe.js";
const RRouterProviders=[
  {value:"openrouter",label:"OpenRouter",description:"Route through your OpenRouter account and selected model.",kind:"key",secret:"OPENROUTER_API_KEY"}
],RRouterComposio={value:"composio",label:"Composio",description:"Connect plugins through Composio. Paste a Connect key (ck_\u2026) or a project API key (ak_\u2026).",kind:"key",secret:"COMPOSIO_API_KEY"},RRouterOptions=RRouterProviders.map(s=>({value:s.value,label:s.label})),RRouterEmptyUsage={requests:0,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,costUsd:0,lastUsedAt:null},RRouterEffortOptions=[{value:"none",label:"None"},{value:"minimal",label:"Minimal"},{value:"low",label:"Low"},{value:"medium",label:"Medium"},{value:"high",label:"High"},{value:"xhigh",label:"Extra high"}],RRouterInputClass="sand-9f619 sand-1useyqa sand-1717udv sand-c342km sand-1a2a7pz sand-jbqb8w sand-1wd3ewq sand-fifm61 sand-jb2p0i";
function RInputValue(s){const t=s?.target??s?.currentTarget;return typeof t?.value==="string"?t.value:""}
function RRouterState(){
  
  const[s,e]=RRr.useState({provider:"openrouter",model:"x-ai/grok-4.6",computerModel:null,summarizeModel:null,reasoningEffort:"medium",computerReasoningEffort:"low",usage:null,local:null,error:null});
  RRr.useEffect(()=>{let t=!0;const n=r=>{t&&e(r.detail)};window.addEventListener("sand-router-provider-changed",n);window.desktop.agent.getInferenceRouter().then(r=>{t&&e({...r,provider:"openrouter",error:null})}).catch(r=>{t&&e(i=>({...i,error:String(r?.message??r)}))});return()=>{t=!1;window.removeEventListener("sand-router-provider-changed",n)}},[]);
  const t=async n=>{const r=s;e(i=>({...i,provider:"openrouter",error:null}));try{const i=await window.desktop.agent.setInferenceRouter("openrouter"),o={...i,provider:"openrouter",error:null};e(o);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:o}))}catch(i){e({...r,error:String(i?.message??i)})}};
  const n=async r=>{const i=s;e(o=>({...o,model:r,error:null}));try{const o=await window.desktop.agent.setInferenceRouter(s.provider,{model:r}),l={...o,error:null};e(l);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:l}))}catch(o){e({...i,error:String(o?.message??o)})}};
  const c=async r=>{const i=s;e(o=>({...o,computerModel:r,error:null}));try{const o=await window.desktop.agent.setInferenceRouter(s.provider,{computerModel:r}),l={...o,error:null};e(l);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:l}))}catch(o){e({...i,error:String(o?.message??o)})}};
  const g=async r=>{const i=s;e(o=>({...o,summarizeModel:r,error:null}));try{const o=await window.desktop.agent.setInferenceRouter(s.provider,{summarizeModel:r}),l={...o,error:null};e(l);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:l}))}catch(o){e({...i,error:String(o?.message??o)})}};
  const d=async r=>{const i=s;e(o=>({...o,reasoningEffort:r,error:null}));try{const o=await window.desktop.agent.setInferenceRouter(s.provider,{reasoningEffort:r}),l={...o,error:null};e(l);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:l}))}catch(o){e({...i,error:String(o?.message??o)})}};
  const p=async r=>{const i=s;e(o=>({...o,computerReasoningEffort:r,error:null}));try{const o=await window.desktop.agent.setInferenceRouter(s.provider,{computerReasoningEffort:r}),l={...o,error:null};e(l);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:l}))}catch(o){e({...i,error:String(o?.message??o)})}};
  const h=async r=>{const packs={high:{model:"anthropic/claude-opus-4.6",computerModel:"anthropic/claude-opus-4.6",summarizeModel:"google/gemini-2.5-flash",reasoningEffort:"medium",computerReasoningEffort:"low"},med:{model:"x-ai/grok-4.6",computerModel:"anthropic/claude-sonnet-4.6",summarizeModel:"google/gemini-2.5-flash",reasoningEffort:"medium",computerReasoningEffort:"low"},low:{model:"google/gemini-3.7-flash",computerModel:"anthropic/claude-haiku-4.5",summarizeModel:"qwen/qwen3.8-flash",reasoningEffort:"low",computerReasoningEffort:"low"}};const pack=packs[r];if(pack==null)return;const i=s;e(o=>({...o,...pack,error:null}));try{const o=await window.desktop.agent.setInferenceRouter(s.provider,pack),l={...o,error:null};e(l);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:l}))}catch(o){e({...i,error:String(o?.message??o)})}};
  return[s,t,n,c,d,p,g,h]
}
function RRouterSecrets(){const[s,e]=RRr.useState([]),[t,n]=RRr.useState(0);RRr.useEffect(()=>{let r=!0;window.desktop.secrets.list().then(i=>{r&&e(Array.isArray(i?.keys)?i.keys:[])});return()=>{r=!1}},[t]);return[s,()=>n(r=>r+1)]}
function RRouterNumber(s){return new Intl.NumberFormat().format(s)}
function RRouterCredential({provider:s,state:e,keys:t,onSaved:n}){const[r,i]=RRr.useState(""),[o,l]=RRr.useState(!1),[u,m]=RRr.useState(null);const c=t.includes(s.secret),d=async()=>{if(r.trim().length===0)return;l(!0);m(null);try{const p=await window.desktop.secrets.upsert({[s.secret]:r.trim()});if(p?.synced===false)throw new Error("The key was saved on this Mac, but Grok Bot's computer did not receive it. Wait until the computer is running, then Save again.");i("");n()}catch(p){m(REdgeError(p))}finally{l(!1)}};return RRj.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-6s0dn4 sand-h8yej3",style:{width:360},children:[RRj.jsx("input",{"aria-label":s.secret,className:RRouterInputClass,disabled:o,onChange:v=>i(RInputValue(v)),placeholder:c?"Replace saved key":"Paste API key",style:{fontSize:13,height:34,minWidth:0,padding:"0 10px",width:270},type:"password",value:r}),RRj.jsx(RRbt,{disabled:o||r.trim().length===0,onClick:d,shape:"pill",size:"sm",variant:"secondary",children:o?"Saving\u2026":"Save"}),u?RRj.jsx(RRtxt,{as:"span",color:"red",size:"sm",children:u}):null]})}
function RRouterMoney(s){const t=typeof s==="number"&&Number.isFinite(s)&&s>0?s:0;return new Intl.NumberFormat(undefined,{style:"currency",currency:"USD",minimumFractionDigits:2,maximumFractionDigits:4}).format(t)}
function RRouterUsageRows({usage:s}){return RRj.jsxs("div",{children:[RRj.jsx(RRrow,{label:"Spend",variant:"card",children:RRj.jsx(RRtxt,{as:"span",color:"secondary",size:"sm",children:RRouterMoney(s.costUsd)})}),RRj.jsx(RRrow,{divided:!0,label:"Requests",variant:"card",children:RRj.jsx(RRtxt,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.requests)})}),RRj.jsx(RRrow,{divided:!0,label:"Input tokens",variant:"card",children:RRj.jsx(RRtxt,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.inputTokens)})}),RRj.jsx(RRrow,{divided:!0,label:"Output tokens",variant:"card",children:RRj.jsx(RRtxt,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.outputTokens)})}),RRj.jsx(RRrow,{divided:!0,label:"Cache tokens",variant:"card",children:RRj.jsx(RRtxt,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.cacheReadTokens+s.cacheWriteTokens)})}),RRj.jsx(RRrow,{divided:!0,label:"Last used",variant:"card",children:RRj.jsx(RRtxt,{as:"span",color:"secondary",size:"sm",children:s.lastUsedAt?new Date(s.lastUsedAt).toLocaleString():"Not used yet"})})]})}
function REmailLooksValid(s){return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s??"").trim())}
async function RGravatarUrl(s){const t=String(s??"").trim().toLowerCase();if(!REmailLooksValid(t))return null;const n=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(t)),r=[...new Uint8Array(n)].map(i=>i.toString(16).padStart(2,"0")).join("");return"https://www.gravatar.com/avatar/"+r+"?s=160&d=identicon&r=g"}
function REdgeError(s){const t=typeof s?.detail==="string"&&s.detail.length>0?s.detail:s?.message??s,n=String(t);return n.startsWith("edge/handler-failed: ")?n.slice("edge/handler-failed: ".length):n}
function RRouterModelId(s){return String(s??"").replace(/^~+/,"")}
function RRouterModelMatches(s,e){const t=s.trim().toLowerCase();if(t.length===0)return!0;return e.id.toLowerCase().includes(t)||e.name.toLowerCase().includes(t)}
function RRouterOpenRouterModels({provider:s,model:e,onChange:t,label:n="Model",description:r,ariaLabel:i="OpenRouter model",inherit:o=!1}){const[l,u]=RRr.useState({models:[],error:null,busy:!0}),[q,j]=RRr.useState("");RRr.useEffect(()=>{if(s!=="openrouter")return;let m=!0;u({models:[],error:null,busy:!0});window.desktop.agent.listOpenRouterModels().then(c=>{if(!m)return;u({models:Array.isArray(c?.models)?c.models:[],error:typeof c?.error==="string"?c.error:null,busy:!1})}).catch(c=>{m&&u(d=>({...d,error:REdgeError(c),busy:!1}))});return()=>{m=!1}},[s]);if(s!=="openrouter")return null;const selected=e==null||e==="__inherit__"?"":RRouterModelId(e),all=l.models??[],query=q.trim(),matched=query.length===0?all.filter(c=>c.recommended||c.id===selected):all.filter(c=>RRouterModelMatches(query,c)),shown=matched.slice(0,80),m=shown.map(c=>({value:c.id,label:c.recommended?"Recommended \u00b7 "+c.name:c.name+" \u00b7 "+c.id}));if(selected&&!m.some(p=>p.value===selected))m.unshift({value:selected,label:selected});const c=o?[{value:"__inherit__",label:"Same as Think"},...m]:m,d=e==null||e==="__inherit__"?o?"__inherit__":(c[0]?.value??selected):c.some(p=>p.value===selected)?selected:(c[0]?.value??selected),hint=l.busy?"Loading models from OpenRouter.":query.length===0?r:shown.length===0?"No models match that search.":shown.length<matched.length?"Showing "+shown.length+" of "+matched.length+" matches.":r;return RRj.jsx(RRrow,{divided:!0,description:hint,label:n,variant:"card",children:l.error&&c.length===(o?1:0)?RRj.jsx(RRtxt,{as:"span",color:"red",size:"sm",children:l.error}):RRj.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-dt5ytf",style:{gap:8,width:360},children:[RRj.jsx("input",{"aria-label":i+" search",className:RRouterInputClass,onChange:v=>j(RInputValue(v)),placeholder:"Search models",style:{fontSize:13,height:34,minWidth:0,padding:"0 10px",width:"100%"},value:q}),RRj.jsx(RRsel,{"aria-label":i,onValueChange:p=>{if(p!==null)void t(p==="__inherit__"?null:RRouterModelId(p))},options:c,placement:"bottom-end",size:"lg",value:d,variant:"secondary"})]})})}
function RRouterEffort({provider:s,value:e,onChange:t,label:n,description:r,ariaLabel:i,fallback:o}){if(s!=="openrouter")return null;const l=RRouterEffortOptions.some(u=>u.value===e)?e:o;return RRj.jsx(RRrow,{divided:!0,description:r,label:n,variant:"card",children:RRj.jsx(RRsel,{"aria-label":i,onValueChange:u=>{if(u!==null)void t(u)},options:RRouterEffortOptions,placement:"bottom-end",size:"lg",value:l,variant:"secondary"})})}
function RIsDocker(){const[s,e]=RRr.useState(!1);RRr.useEffect(()=>{let t=!0;(window.desktop.agent.getDesktopEnvironment?window.desktop.agent.getDesktopEnvironment():Promise.resolve(null)).then(n=>{t&&e(n&&n.runtime==="docker")}).catch(()=>{});return()=>{t=!1}},[]);return s}
function RBoxIdleOptions(){return[{value:"0",label:"Off"},{value:String(15*60*1e3),label:"15 minutes"},{value:String(30*60*1e3),label:"30 minutes"},{value:String(60*60*1e3),label:"1 hour"},{value:String(2*60*60*1e3),label:"2 hours"}]}
function RBoxRuntime(){const docker=RIsDocker();const[s,e]=RRr.useState({mode:"local-docker",status:null,idleMs:30*60*1e3,suspended:!1,error:null,busy:!0,acting:null});const n=()=>window.desktop.agent.getBoxRuntime().then(r=>{e(i=>({...i,...r,error:null,busy:!1}))}).catch(r=>{e(i=>({...i,error:REdgeError(r),busy:!1}))});RRr.useEffect(()=>{let t=!0;n();const p=setInterval(()=>{t&&n()},2e3);return()=>{t=!1;clearInterval(p)}},[]);const running=s.status?.ready||s.status?.running,sleeping=s.suspended===!0||!running&&s.idleMs>0,label=docker?"Owned by this web runtime":s.acting==="wake"?"Starting":s.busy?"Checking\u2026":s.status?.available===!1?"Docker unavailable":sleeping?"Sleeping":running?"Running":"Not running",hint=docker?"Shell, files and computer use run in the Compose box service.":sleeping?"The local Docker VM is stopped until you wake it or send a message.":(s.status?.detail??"Shell, files and computer use run in a local Docker VM on this Mac.");const idleValue=String(typeof s.idleMs==="number"?s.idleMs:30*60*1e3);const act=async(kind,work)=>{e(i=>({...i,acting:kind,error:null}));try{const r=await work();e(i=>({...i,...r,acting:null,busy:!1,error:null}))}catch(r){e(i=>({...i,acting:null,error:REdgeError(r)}))}};return RRj.jsxs("div",{children:[RRj.jsx(RRrow,{description:hint,label:"Computer",variant:"card",children:RRj.jsx(RRtxt,{as:"span",color:running&&!sleeping?"primary":"secondary",size:"sm",children:label})}),docker?null:RRj.jsx(RRrow,{divided:!0,description:"Stops the local Docker VM after this much idle time so it is not using CPU and RAM. Sending a message or clicking Wake starts it again.",label:"Auto-suspend",variant:"card",children:RRj.jsx(RRsel,{"aria-label":"Auto-suspend idle time",onValueChange:r=>{if(r!==null)void act("idle",()=>window.desktop.agent.setBoxAutoSuspendIdleMs(Number(r)))},options:RBoxIdleOptions(),placement:"bottom-end",size:"lg",value:idleValue,variant:"secondary"})}),RRj.jsx(RBoxActions,{act,running,sleeping})]})}
function RBoxActions({act,running,sleeping}){return RRj.jsxs("div",{children:[sleeping?RRj.jsx(RRrow,{divided:!0,label:"Computer",variant:"card",children:RRj.jsx(RRbt,{onClick:()=>void act("wake",()=>window.desktop.agent.resumeBox()),shape:"pill",size:"sm",variant:"secondary",children:"Wake"})}):null,running&&!sleeping?RRj.jsx(RRrow,{divided:!0,label:"Computer",variant:"card",children:RRj.jsx(RRbt,{onClick:()=>void act("sleep",()=>window.desktop.agent.suspendBox()),shape:"pill",size:"sm",variant:"secondary",children:"Sleep"})}):null]})}
function RRouterPresets({onApply:s}){return RRj.jsx(RRrow,{description:"Write Think, Drive, and Summarize together.",label:"Preset",variant:"card",children:RRj.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-6s0dn4",style:{gap:8,width:360},children:[RRj.jsx(RRbt,{onClick:()=>void s("high"),shape:"pill",size:"sm",variant:"secondary",children:"High"}),RRj.jsx(RRbt,{onClick:()=>void s("med"),shape:"pill",size:"sm",variant:"secondary",children:"Med"}),RRj.jsx(RRbt,{onClick:()=>void s("low"),shape:"pill",size:"sm",variant:"secondary",children:"Low"})]})})}
function RRouterPanel(){const[s,,t,n,c,d,g,h]=RRouterState(),[lk,i]=RRouterSecrets(),r=RRouterProviders[0],o=s.usage?.providers?.openrouter??RRouterEmptyUsage;return RRj.jsx(RRscroll,{children:RRj.jsxs("div",{className:RRcn("sand-settings-general","sand-9f619 sand-78zum5 sand-dt5ytf sand-3qzy4x"),children:[RRj.jsx(RRsec,{title:"You",children:RRj.jsx(RLocalProfile,{})}),RRj.jsx(RRsec,{title:"Routing",children:RRj.jsxs("div",{children:[RRj.jsx(RRrow,{description:r.description,label:"Provider",variant:"card",children:RRj.jsx(RRtxt,{as:"span",color:"secondary",size:"sm",children:"OpenRouter"})}),RRj.jsx(RRouterPresets,{onApply:h}),RRj.jsx(RRouterOpenRouterModels,{provider:"openrouter",model:s.model??"x-ai/grok-4.6",onChange:t,label:"Think model",description:"Used for chat and turns that do not need the screen.",ariaLabel:"OpenRouter think model"}),RRj.jsx(RRouterEffort,{provider:"openrouter",value:s.reasoningEffort??"medium",onChange:c,label:"Think reasoning",description:"Thinking effort for chat and turns that do not need the screen.",ariaLabel:"OpenRouter think reasoning effort",fallback:"medium"}),RRj.jsx(RRouterOpenRouterModels,{provider:"openrouter",model:s.computerModel??"anthropic/claude-sonnet-4.6",onChange:n,label:"Drive model",description:"Used when the agent needs the box screen. Screen and click stay on this one model.",ariaLabel:"OpenRouter drive model"}),RRj.jsx(RRouterEffort,{provider:"openrouter",value:s.computerReasoningEffort??"low",onChange:d,label:"Drive reasoning",description:"Thinking effort while driving the box screen. Low keeps clicks fast.",ariaLabel:"OpenRouter drive reasoning effort",fallback:"low"}),RRj.jsx(RRouterOpenRouterModels,{provider:"openrouter",model:s.summarizeModel??"__inherit__",onChange:g,label:"Summarize model",description:"Used to compress long transcripts. Same as Think when unset.",ariaLabel:"OpenRouter summarize model",inherit:!0})]})}),RRj.jsx(RRsec,{title:"Computer",children:RRj.jsx(RBoxRuntime,{})}),RRj.jsx(RRsec,{title:"OpenRouter account",children:RRj.jsx(RRrow,{description:r.description,label:r.label,variant:"card",children:RRj.jsx(RRouterCredential,{provider:r,state:s,keys:lk,onSaved:i})})}),RRj.jsx(RRsec,{title:"OpenRouter usage",children:RRouterUsageRows({usage:o})})]})})}
function RLocalProfile(){const[s,e]=RRr.useState({name:"Local",email:"",gravatarUrl:null,draftName:"Local",draftEmail:"",previewUrl:"",busy:!1,saved:!1,error:""});RRr.useEffect(()=>{let t=!0;(window.desktop.agent.getLocalProfile?window.desktop.agent.getLocalProfile():Promise.resolve({name:"Local",email:"",gravatarUrl:null})).then(n=>{if(!t)return;const d=typeof n?.name==="string"&&n.name.trim().length>0?n.name:"Local",g=typeof n?.email==="string"?n.email:"";e(r=>({...r,name:d,email:g,gravatarUrl:n?.gravatarUrl??null,draftName:d,draftEmail:g,previewUrl:typeof n?.gravatarUrl==="string"?n.gravatarUrl:""}))}).catch(n=>{t&&e(r=>({...r,error:REdgeError(n)}))});return()=>{t=!1}},[]);RRr.useEffect(()=>{let t=!0;if(!REmailLooksValid(s.draftEmail)){e(n=>({...n,previewUrl:""}));return}RGravatarUrl(s.draftEmail).then(n=>{t&&e(r=>({...r,previewUrl:typeof n==="string"?n:""}))});return()=>{t=!1}},[s.draftEmail]);const n=s.draftName!==s.name||s.draftEmail!==s.email,r=async()=>{if(s.draftEmail.trim().length>0&&!REmailLooksValid(s.draftEmail)){e(i=>({...i,error:"Enter a valid email, or leave it blank."}));return}e(i=>({...i,busy:!0,saved:!1,error:""}));try{await window.desktop.agent.setLocalProfile({name:s.draftName,email:s.draftEmail});const i=await (window.desktop.agent.getLocalProfile?window.desktop.agent.getLocalProfile():Promise.resolve({name:s.draftName,email:s.draftEmail,gravatarUrl:s.previewUrl}));const d=typeof i?.name==="string"&&i.name.trim().length>0?i.name:s.draftName,g=typeof i?.email==="string"?i.email:s.draftEmail,p=typeof i?.gravatarUrl==="string"?i.gravatarUrl:(typeof s.previewUrl==="string"?s.previewUrl:"");e(o=>({...o,name:d,email:g,gravatarUrl:p||null,draftName:d,draftEmail:g,previewUrl:p,busy:!1,saved:!0,error:""}))}catch(i){e(o=>({...o,busy:!1,error:REdgeError(i)}))}};return RRj.jsxs("div",{children:[RRj.jsx(RRrow,{description:"Shown in the sidebar. Add an email to load your Gravatar, or an identicon if you do not have one yet.",label:"Profile",variant:"card",children:null}),RRj.jsx(RRrow,{divided:!0,label:"Name",variant:"card",children:RRj.jsx("input",{"aria-label":"Name",className:RRouterInputClass,onChange:i=>e(o=>({...o,draftName:RInputValue(i)})),placeholder:"Your name",style:{fontSize:13,height:34,minWidth:0,padding:"0 10px",width:270},value:s.draftName})}),RRj.jsx(RRrow,{divided:!0,label:"Email",variant:"card",children:RRj.jsx("input",{"aria-label":"Email",className:RRouterInputClass,onChange:i=>e(o=>({...o,draftEmail:RInputValue(i)})),placeholder:"you@example.com",style:{fontSize:13,height:34,minWidth:0,padding:"0 10px",width:270},type:"email",value:s.draftEmail})}),s.previewUrl?RRj.jsx(RRrow,{divided:!0,label:"Avatar preview",variant:"card",children:RRj.jsx("img",{alt:"Avatar preview",src:s.previewUrl,style:{borderRadius:"50%",height:48,width:48}})}):null,RRj.jsx(RRrow,{divided:!0,label:"Save profile",variant:"card",children:RRj.jsx(RRbt,{disabled:!n||s.busy,onClick:()=>void r(),shape:"pill",size:"sm",variant:"secondary",children:s.busy?"Saving\u2026":s.saved?"Saved":"Save"})}),s.error?RRj.jsx(RRrow,{divided:!0,label:"Error",variant:"card",children:RRj.jsx(RRtxt,{as:"span",color:"red",size:"sm",children:s.error})}):null]})}
function RRouterPage(n){const {params:t}=n,o=t?.focusSetting??null;return RRj.jsx(RRfocus,{focus:o,children:RRj.jsx(RRouterPanel,{})})}
export{RRouterPage as default,RRouterPanel};
`;

// --- end 0.36 constants ---

export async function applyO36RendererRouterPatch({ stageRoot }) {
  const assetsRoot = path.join(stageRoot, "dist", "renderer", "assets");
  const viewsRoot = path.join(stageRoot, "dist", "renderer");
  const mainCandidates = [];
  const autoCandidates = [];
  const shellCandidates = [];
  for (const name of await readdir(assetsRoot)) {
    if (!name.endsWith(".js")) continue;
    const target = path.join(assetsRoot, name);
    const source = await readFile(target, "utf8");
    if (source.includes(O36_MAIN_Y2_IC_BEFORE)) mainCandidates.push({ name, target, source });
    if (source.includes(O36_AUTO_MENU_BEFORE)) autoCandidates.push({ name, target, source });
    if (source.includes(O36_SHELL_IMAP_BEFORE) && source.includes(O36_SHELL_IMPORT_BEFORE)) shellCandidates.push({ name, target, source });
  }
  if (mainCandidates.length !== 1) throw new Error(`Expected one 0.36 settings main chunk, found ${mainCandidates.length}.`);
  if (autoCandidates.length !== 1) throw new Error(`Expected one 0.36 automation detail chunk, found ${autoCandidates.length}.`);
  if (shellCandidates.length !== 1) throw new Error(`Expected one 0.36 settings shell chunk, found ${shellCandidates.length}.`);

  const changes = [];
  const mainTransforms = [
    ["settings-entrypoints", O36_MAIN_Y2_IC_BEFORE, O36_MAIN_Y2_IC_AFTER],
    ["catalog-entrypoint", O36_MAIN_GWT_BEFORE, O36_MAIN_GWT_AFTER],
    ["catalog-view", O36_MAIN_HWT_BEFORE, O36_MAIN_HWT_AFTER],
    ["palette-keywords", O36_MAIN_BPT_BEFORE, O36_MAIN_BPT_AFTER],
    ["composio-trigger-defaults", O36_MAIN_FMET_BEFORE, O36_MAIN_FMET_AFTER],
    ["composio-trigger-load", O36_MAIN_IKE_BEFORE, O36_MAIN_IKE_AFTER],
    ["composio-trigger-save", O36_MAIN_OKE_SAVE_BEFORE, O36_MAIN_OKE_SAVE_AFTER],
    ["composio-trigger-sentence", O36_MAIN_WMT_BEFORE, O36_MAIN_WMT_AFTER],
    ["composio-event-sentence", O36_MAIN_OKET_BEFORE, O36_MAIN_OKET_AFTER],
  ];
  changes.push(await applyO36Transforms(mainCandidates[0], mainTransforms));

  const autoTransforms = [
    ["composio-trigger-menu", O36_AUTO_MENU_BEFORE, O36_AUTO_MENU_AFTER],
    ["composio-trigger-glyph", O36_AUTO_GLYPH_BEFORE, O36_AUTO_GLYPH_AFTER],
    ["composio-trigger-fields", O36_AUTO_FIELDS_BEFORE, O36_AUTO_FIELDS_AFTER],
  ];
  changes.push(await applyO36Transforms(autoCandidates[0], autoTransforms));

  const shellTransforms = [
    ["router-view-import", O36_SHELL_IMPORT_BEFORE, O36_SHELL_IMPORT_AFTER],
    ["router-view-dialog-map", O36_SHELL_IMAP_BEFORE, O36_SHELL_IMAP_AFTER],
  ];
  changes.push(await applyO36Transforms(shellCandidates[0], shellTransforms));

  const viewPath = path.join(assetsRoot, O36_CHUNK_VIEW_NAME);
  await writeFile(viewPath, O36_ROUTER_VIEW_CHUNK);
  changes.push({
    role: "router-page",
    path: `dist/renderer/assets/${O36_CHUNK_VIEW_NAME}`,
    created: { bytes: Buffer.byteLength(O36_ROUTER_VIEW_CHUNK), sha256: sha256(O36_ROUTER_VIEW_CHUNK) },
  });

  const record = {
    schemaVersion: 1,
    mode: "original-renderer-036-settings-extension",
    rendererVariant: "0.36.0-web",
    chunks: changes,
    features: ["settings-router-provider", "settings-openrouter-model", "settings-openrouter-computer-model", "settings-openrouter-reasoning-effort", "settings-openrouter-model-search", "settings-local-docker-status", "settings-box-auto-suspend", "settings-composio", "settings-local-profile", "settings-gravatar", "usage-openrouter-cost", "routines-composio-gmail"],
    transformations: [
      "settings-entrypoints", "catalog-entrypoint", "catalog-view", "palette-keywords",
      "composio-trigger-menu", "composio-trigger-glyph", "composio-trigger-fields",
      "composio-trigger-defaults", "composio-trigger-load", "composio-trigger-save",
      "composio-trigger-sentence", "composio-event-sentence",
      "router-view-import", "router-view-dialog-map", "router-page",
    ],
  };
  const provenancePath = path.join(viewsRoot, "renderer-router-extension.json");
  await writeFile(provenancePath, `${JSON.stringify(record, null, 2)}\n`);
  return { ...record, provenancePath, provenanceBytes: (await stat(provenancePath)).size };
}

async function applyO36Transforms(candidate, transforms) {
  let patched = candidate.source;
  for (const [label, before, after] of transforms) {
    patched = replaceExactlyOnce(patched, before, after, `0.36 ${label}`);
  }
  await writeFile(candidate.target, patched);
  return {
    role: candidate.name,
    path: `dist/renderer/assets/${candidate.name}`,
    original: { bytes: Buffer.byteLength(candidate.source), sha256: sha256(candidate.source) },
    patched: { bytes: Buffer.byteLength(patched), sha256: sha256(patched) },
    transforms: transforms.map(([label]) => label),
  };
}

