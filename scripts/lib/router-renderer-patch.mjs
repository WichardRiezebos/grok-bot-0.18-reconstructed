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
  {value:"cursor",label:"Cursor",description:"Use your signed-in Cursor account.",kind:"account"},
  {value:"claude-code",label:"Claude Code",description:"Use your existing Claude Code sign-in and Grok Bot's connected plugins.",kind:"local",localKey:"claude-code"},
  {value:"codex",label:"Codex",description:"Use your existing ChatGPT sign-in from Codex with Grok Bot's connected plugins.",kind:"local",localKey:"codex"},
  {value:"openrouter",label:"OpenRouter",description:"Route through your OpenRouter account and selected model.",kind:"key",secret:"OPENROUTER_API_KEY"}
],RRouterOptions=RRouterProviders.map(s=>({value:s.value,label:s.label})),RRouterEmptyUsage={requests:0,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,lastUsedAt:null},RRouterEffortOptions=[{value:"none",label:"None"},{value:"minimal",label:"Minimal"},{value:"low",label:"Low"},{value:"medium",label:"Medium"},{value:"high",label:"High"},{value:"xhigh",label:"Extra high"}],RRouterInputClass="sand-9f619 sand-h8yej3 sand-5f5z56 sand-u97haq sand-lrnmfh sand-uve7l6 sand-16b7oty sand-1rgtt3y sand-o7x2bt sand-mkeg23 sand-1y0btm7 sand-qz0629 sand-1043rbw sand-13l7odt sand-1wd3ewq sand-jb2p0i sand-4z9k3i sand-frs9s4 sand-tt52l0 sand-1odjw0f sand-1t137rt sand-ltfok3";
function RRouterState(){
  const[s,e]=de.useState({provider:"cursor",model:"openai/gpt-4.1",computerModel:null,reasoningEffort:"medium",computerReasoningEffort:"low",usage:null,local:null,error:null});
  de.useEffect(()=>{let t=!0;const n=r=>{t&&e(r.detail)};window.addEventListener("sand-router-provider-changed",n);window.desktop.agent.getInferenceRouter().then(r=>{t&&e({...r,error:null})}).catch(r=>{t&&e(i=>({...i,error:String(r?.message??r)}))});return()=>{t=!1;window.removeEventListener("sand-router-provider-changed",n)}},[]);
  const t=async n=>{const r=s;e(i=>({...i,provider:n,error:null}));try{const i=await window.desktop.agent.setInferenceRouter(n),o={...i,error:null};e(o);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:o}))}catch(i){e({...r,error:String(i?.message??i)})}};
  const n=async r=>{const i=s;e(o=>({...o,model:r,error:null}));try{const o=await window.desktop.agent.setInferenceRouter(s.provider,{model:r}),l={...o,error:null};e(l);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:l}))}catch(o){e({...i,error:String(o?.message??o)})}};
  const c=async r=>{const i=s;e(o=>({...o,computerModel:r,error:null}));try{const o=await window.desktop.agent.setInferenceRouter(s.provider,{computerModel:r}),l={...o,error:null};e(l);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:l}))}catch(o){e({...i,error:String(o?.message??o)})}};
  const d=async r=>{const i=s;e(o=>({...o,reasoningEffort:r,error:null}));try{const o=await window.desktop.agent.setInferenceRouter(s.provider,{reasoningEffort:r}),l={...o,error:null};e(l);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:l}))}catch(o){e({...i,error:String(o?.message??o)})}};
  const p=async r=>{const i=s;e(o=>({...o,computerReasoningEffort:r,error:null}));try{const o=await window.desktop.agent.setInferenceRouter(s.provider,{computerReasoningEffort:r}),l={...o,error:null};e(l);window.dispatchEvent(new CustomEvent("sand-router-provider-changed",{detail:l}))}catch(o){e({...i,error:String(o?.message??o)})}};
  return[s,t,n,c,d,p]
}
function RRouterSecrets(){const[s,e]=de.useState([]),[t,n]=de.useState(0);de.useEffect(()=>{let r=!0;window.desktop.secrets.list().then(i=>{r&&e(Array.isArray(i?.keys)?i.keys:[])});return()=>{r=!1}},[t]);return[s,()=>n(r=>r+1)]}
function RRouterNumber(s){return new Intl.NumberFormat().format(s)}
function RRouterCredential({provider:s,state:e,keys:t,onSaved:n}){const[r,i]=de.useState(""),[o,l]=de.useState(!1),[u,m]=de.useState(null);if(s.kind==="account")return a.jsx(se,{as:"span",color:"secondary",size:"sm",children:"Signed in"});if(s.kind==="local"){const c=e.local?.[s.localKey],d=c?.installed&&c?.authenticated;return a.jsx(se,{as:"span",color:d?"primary":"secondary",size:"sm",children:d?"Ready":c?.installed?"Sign in with "+(s.value==="codex"?"codex login":"claude"):"Not installed"})}const c=t.includes(s.secret),d=async()=>{if(r.trim().length===0)return;l(!0);m(null);try{const p=await window.desktop.secrets.upsert({[s.secret]:r.trim()});if(p?.synced===false)throw new Error("The key was saved on this Mac, but Grok Bot's computer did not receive it. Wait until the computer is running, then Save again.");i("");n()}catch(p){m(REdgeError(p))}finally{l(!1)}};return a.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-6s0dn4 sand-h8yej3",style:{width:360},children:[a.jsx("input",{"aria-label":s.secret,className:RRouterInputClass,disabled:o,onChange:v=>i(v.currentTarget.value),placeholder:c?"Replace saved key":"Paste API key",style:{fontSize:13,height:34,minWidth:0,padding:"0 10px",width:270},type:"password",value:r}),a.jsx(oe,{disabled:o||r.trim().length===0,onClick:d,shape:"rectangular",size:"sm",variant:"secondary",children:o?"Saving…":"Save"}),u?a.jsx(se,{as:"p",color:"red",size:"sm",children:u}):null]})}
function RRouterUsageRows({usage:s}){return a.jsxs("div",{children:[a.jsx(ie,{label:"Requests",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.requests)})}),a.jsx(ie,{divided:!0,label:"Input tokens",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.inputTokens)})}),a.jsx(ie,{divided:!0,label:"Output tokens",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.outputTokens)})}),a.jsx(ie,{divided:!0,label:"Cache tokens",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:RRouterNumber(s.cacheReadTokens+s.cacheWriteTokens)})}),a.jsx(ie,{divided:!0,label:"Last used",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:s.lastUsedAt?new Date(s.lastUsedAt).toLocaleString():"Not used yet"})})]})}
function REdgeError(s){const t=typeof s?.detail==="string"&&s.detail.length>0?s.detail:s?.message??s,n=String(t);return n.startsWith("edge/handler-failed: ")?n.slice("edge/handler-failed: ".length):n}
function RRouterModelId(s){return String(s??"").replace(/^~+/,"");}
function RRouterModelMatches(s,e){const t=s.trim().toLowerCase();if(t.length===0)return!0;return e.id.toLowerCase().includes(t)||e.name.toLowerCase().includes(t)}
function RRouterOpenRouterModels({provider:s,model:e,onChange:t,label:n="Model",description:r,ariaLabel:i="OpenRouter model",inherit:o=!1}){const[l,u]=de.useState({models:[],error:null,busy:!0}),[q,j]=de.useState("");de.useEffect(()=>{if(s!=="openrouter")return;let m=!0;u({models:[],error:null,busy:!0});window.desktop.agent.listOpenRouterModels().then(c=>{if(!m)return;u({models:Array.isArray(c?.models)?c.models:[],error:typeof c?.error==="string"?c.error:null,busy:!1})}).catch(c=>{m&&u(d=>({...d,error:REdgeError(c),busy:!1}))});return()=>{m=!1}},[s]);if(s!=="openrouter")return null;const selected=e==null||e==="__inherit__"?"":RRouterModelId(e),all=l.models??[],query=q.trim(),matched=query.length===0?all.filter(c=>c.recommended||c.id===selected):all.filter(c=>RRouterModelMatches(query,c)),shown=matched.slice(0,80),m=shown.map(c=>({value:c.id,label:c.recommended?"Recommended · "+c.name:c.name+" · "+c.id}));if(selected&&!m.some(p=>p.value===selected))m.unshift({value:selected,label:selected});const c=o?[{value:"__inherit__",label:"Same as chat"},...m]:m,d=e==null||e==="__inherit__"?o?"__inherit__":(c[0]?.value??selected):c.some(p=>p.value===selected)?selected:(c[0]?.value??selected),hint=l.busy?"Loading models from OpenRouter.":query.length===0?r:shown.length===0?"No models match that search.":shown.length<matched.length?"Showing "+shown.length+" of "+matched.length+" matches.":r;return a.jsx(ie,{divided:!0,description:hint,label:n,variant:"card",children:l.error&&c.length===(o?1:0)?a.jsx(se,{as:"span",color:"red",size:"sm",children:l.error}):a.jsxs("div",{className:"sand-9f619 sand-78zum5 sand-dt5ytf",style:{gap:8,width:360},children:[a.jsx("input",{"aria-label":i+" search",className:RRouterInputClass,onChange:v=>j(v.currentTarget.value),placeholder:"Search models",style:{fontSize:13,height:34,minWidth:0,padding:"0 10px",width:"100%"},value:q}),a.jsx(ye,{"aria-label":i,onValueChange:p=>{if(p!==null)void t(p==="__inherit__"?null:RRouterModelId(p))},options:c.length>0?c:[{value:d,label:d}],placement:"bottom-end",size:"lg",value:d,variant:"filled"})]})})}
function RRouterEffort({provider:s,value:e,onChange:t,label:n,description:r,ariaLabel:i,fallback:o}){if(s!=="openrouter")return null;const l=RRouterEffortOptions.some(u=>u.value===e)?e:o;return a.jsx(ie,{divided:!0,description:r,label:n,variant:"card",children:a.jsx(ye,{"aria-label":i,onValueChange:u=>{if(u!==null)void t(u)},options:RRouterEffortOptions,placement:"bottom-end",size:"lg",value:l,variant:"filled"})})}
function RIsDocker(){const[s,e]=de.useState(!1);de.useEffect(()=>{let t=!0;(window.desktop.agent.getDesktopEnvironment?window.desktop.agent.getDesktopEnvironment():Promise.resolve(null)).then(n=>{t&&e(n&&n.runtime==="docker")}).catch(()=>{});return()=>{t=!1}},[]);return s}
function RBoxRuntime(){const docker=RIsDocker();const[s,e]=de.useState({mode:"remote",status:null,error:null,busy:!0});de.useEffect(()=>{let t=!0;window.desktop.agent.getBoxRuntime().then(n=>{t&&e({...n,error:null,busy:!1})}).catch(n=>{t&&e(r=>({...r,error:REdgeError(n),busy:!1}))});return()=>{t=!1}},[]);const t=s.mode==="local-docker",n=async()=>{const r=t?"remote":"local-docker";e(i=>({...i,mode:r,busy:!0,error:null}));try{const i=await window.desktop.agent.setBoxRuntime(r);e({...i,error:null,busy:!1})}catch(i){e(o=>({...o,mode:t?"local-docker":"remote",error:REdgeError(i),busy:!1}))}};if(docker)return a.jsx(ie,{description:"Shell, files and computer use run in the Compose box service.",label:"Computer",variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:"Owned by this web runtime"})});return a.jsxs("div",{children:[a.jsx(ie,{description:t?(s.status?.detail??"Shell, files and computer use run in a local container on this Mac."):"Shell, files and computer use run on Grok Bot's remote computer.",label:"Use local Docker VM",variant:"card",children:a.jsx("button",{"aria-checked":t,"aria-label":"Use local Docker VM",disabled:s.busy,onClick:n,role:"switch",style:{appearance:"none",background:t?"var(--color-accent-primary, #4f8cff)":"rgba(255,255,255,.14)",border:0,borderRadius:999,cursor:s.busy?"wait":"pointer",height:22,opacity:s.busy?0.65:1,padding:2,position:"relative",transition:"background .15s ease",width:38},type:"button",children:a.jsx("span",{style:{background:"white",borderRadius:"50%",boxShadow:"0 1px 3px rgba(0,0,0,.35)",display:"block",height:18,transform:"translateX("+(t?16:0)+"px)",transition:"transform .15s ease",width:18}})})}),s.error?a.jsx(se,{as:"p",color:"red",size:"sm",children:s.error}):null]})}
function RRouterPanel(){const docker=RIsDocker();const[s,e,t,n,c,d]=RRouterState(),[r,i]=RRouterSecrets(),providers=docker?RRouterProviders.filter(l=>l.value==="openrouter"):RRouterProviders,o=providers.find(l=>l.value===s.provider)??providers[0],l=s.usage?.providers?.[s.provider]??RRouterEmptyUsage,u=o.value==="codex"?"Uses the private ChatGPT login already stored by Codex on this Mac. Requests are made by Grok Bot directly.":o.kind==="local"?"Uses Claude Code's existing login on this Mac.":o.kind==="key"?"Stored securely with your other Grok Bot secrets.":"Uses the account already connected to Grok Bot.";return a.jsx(Te,{children:a.jsxs("div",{className:k("sand-settings-general","sand-9f619 sand-78zum5 sand-dt5ytf sand-3qzy4x"),children:[a.jsx(re,{title:"Routing",children:a.jsxs("div",{children:[a.jsx(ie,{description:o.description,label:"Provider",variant:"card",children:a.jsx(ye,{"aria-label":"Routing provider",onValueChange:m=>{if(m!==null)void e(m)},options:providers.map(m=>({value:m.value,label:m.label})),placement:"bottom-end",size:"lg",value:s.provider,variant:"filled"})}),a.jsx(RRouterOpenRouterModels,{provider:s.provider,model:s.model??"openai/gpt-4.1",onChange:t,label:"Chat model",description:"Used for thinking, chat, and turns without Computer.",ariaLabel:"OpenRouter chat model"}),a.jsx(RRouterEffort,{provider:s.provider,value:s.reasoningEffort??"medium",onChange:c,label:"Chat reasoning",description:"Thinking effort for chat and turns without Computer.",ariaLabel:"OpenRouter chat reasoning effort",fallback:"medium"}),a.jsx(RRouterOpenRouterModels,{provider:s.provider,model:s.computerModel??"__inherit__",onChange:n,label:"Computer model",description:"Used when the agent drives the box screen. Qwen 3.7 Flash is cheap and good at screenshots and clicks.",ariaLabel:"OpenRouter computer model",inherit:!0}),a.jsx(RRouterEffort,{provider:s.provider,value:s.computerReasoningEffort??"low",onChange:d,label:"Computer reasoning",description:"Thinking effort while driving the box screen. Low keeps clicks fast.",ariaLabel:"OpenRouter computer reasoning effort",fallback:"low"})]})}),docker?null:a.jsx(re,{title:"Computer",children:a.jsx(RBoxRuntime,{})}),a.jsx(re,{title:o.kind==="key"?"OpenRouter account":"Account",children:a.jsx(ie,{description:u,label:o.kind==="key"?"API key":"Status",variant:"card",children:a.jsx(RRouterCredential,{provider:o,state:s,keys:r,onSaved:i})})}),s.error?a.jsx(se,{as:"p",color:"red",size:"sm",children:s.error}):null,a.jsx(re,{title:"Usage for "+o.label,children:a.jsx(RRouterUsageRows,{usage:l})})]})})}
function RRouterUsageSummary({provider:s,usage:e,current:t,divided:n}){const r=[RRouterNumber(e.requests)+" requests",RRouterNumber(e.inputTokens)+" input",RRouterNumber(e.outputTokens)+" output",RRouterNumber(e.cacheReadTokens+e.cacheWriteTokens)+" cached"].join(" · "),i=t?"Current route":e.lastUsedAt?new Date(e.lastUsedAt).toLocaleString():"Not used yet";return a.jsx(ie,{divided:n,description:r,label:s.label,variant:"card",children:a.jsx(se,{as:"span",color:t?"primary":"secondary",size:"sm",children:i})})}
function RRouterUsage(){const[s]=RRouterState(),e=RRouterProviders.find(t=>t.value===s.provider)??RRouterProviders[0],t=RRouterProviders.filter(n=>n.value===s.provider||(s.usage?.providers?.[n.value]?.requests??0)>0);return a.jsxs("div",{className:k("sand-usage-section","sand-9f619 sand-78zum5 sand-dt5ytf sand-ou54vl"),children:[a.jsx(re,{title:"Current provider",children:a.jsx(ie,{description:e.description,label:e.label,variant:"card",children:a.jsx(se,{as:"span",color:"secondary",size:"sm",children:"Selected"})})}),a.jsx(re,{title:"Tracked activity",children:a.jsx("div",{children:t.map((n,r)=>a.jsx(RRouterUsageSummary,{provider:n,usage:s.usage?.providers?.[n.value]??RRouterEmptyUsage,current:n.value===s.provider,divided:r>0},n.value))})}),s.provider==="cursor"?a.jsx(Na,{}):null]})}
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

export function patchOriginalSettingsPanel(source) {
  let patched = replaceExactlyOnce(source, COMPONENT_ANCHOR, `${COMPONENT_SOURCE}${COMPONENT_ANCHOR}`, "component insertion");
  patched = replaceExactlyOnce(patched, GENERAL_BEFORE, GENERAL_AFTER, "Router panel switch");
  patched = replaceExactlyOnce(patched, USAGE_BEFORE, USAGE_AFTER, "Usage panel switch");
  return patched;
}

export async function applyOriginalRendererRouterPatch({ stageRoot }) {
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
    ["registry", registryCandidates[0], patchOriginalSettingsRegistry],
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
    features: ["settings-router-provider", "settings-openrouter-model", "settings-openrouter-computer-model", "settings-openrouter-reasoning-effort", "settings-openrouter-model-search", "settings-local-docker-vm", "usage-current-provider"],
    transformations: ["settings-registry", "router-panel", "usage-panel"],
  };
  const provenancePath = path.join(stageRoot, "dist", "renderer-router-extension.json");
  await writeFile(provenancePath, `${JSON.stringify(record, null, 2)}\n`);
  return { ...record, provenancePath, provenanceBytes: (await stat(provenancePath)).size };
}
