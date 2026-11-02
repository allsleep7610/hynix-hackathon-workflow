import {readFile,writeFile,readdir,lstat,realpath,open,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {readRegularFile,digest,parseSession} from '../../.agents/skills/my-session-save/scripts/session-document.mjs';
import {directory,inside,validId,json} from './session-context.mjs';

const EVENTS=['SessionStart','UserPromptSubmit','PostToolUse'];
const quote=s=>`'${s.replaceAll("'",`'"'"'`)}'`;
const psquote=s=>`'${s.replaceAll("'","''")}'`;
async function optional(file){try{return await readRegularFile(file,1024*1024);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function atomic(file,text,mode=0o600){const tmp=path.join(path.dirname(file),`.hynix-${randomUUID()}.tmp`);let h;try{h=await open(tmp,'wx',mode);await h.writeFile(text,'utf8');await h.sync();await h.close();h=null;await rename(tmp,file);}finally{await h?.close();await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
const hasInline=s=>/^\s*\[\[?hooks(?:[.\]])/m.test(s||'');
const commands=config=>Object.values(config.hooks||{}).flatMap(groups=>{if(!Array.isArray(groups))throw Error('hook groups must be arrays');return groups.flatMap(group=>{if(!Array.isArray(group.hooks))throw Error('hook handlers must be arrays');return group.hooks.map(h=>h.command||'');});});
export async function setup({workspace,remove=false,check=false,sessionId,document,codexHome=process.env.CODEX_HOME||path.join(os.homedir(),'.codex')}){
 const root=await realpath(workspace);
 const packageRoot=await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'));
 if(!inside(root,packageRoot))throw Error('place the harness package inside the allowed workspace before registration');
 for(const rel of ['.codex','.hynix-harness/runtime']){
  try{await directory(root,rel);}catch(e){if(e.code!=='ENOENT')throw e;}
 }
 if(Boolean(sessionId)!==Boolean(document))throw Error('adopting a document requires both --session-id and --document');
 let bound=null;
 if(document){
  validId(sessionId);const full=path.resolve(root,document);
  if(!inside(root,full)||path.basename(full)!=='SESSION.md')throw Error('document must be a SESSION.md inside the workspace');
  await directory(root,path.relative(root,path.dirname(full)));
  const text=await readRegularFile(full);if(text===null)throw Error('document missing');parseSession(text);
  bound={session_id:sessionId,document:path.relative(root,full)};
 }
 const configPath=path.join(root,'.codex/hooks.json');
 const runtime=path.join(root,'.hynix-harness/runtime');
 const manifestPath=path.join(runtime,'registration.json');
 let raw=await optional(configPath);
 let config=raw===null?{}:json(raw,'invalid project hook JSON');
 if(!config||typeof config!=='object'||Array.isArray(config)||config.hooks&&(typeof config.hooks!=='object'||Array.isArray(config.hooks)))throw Error('invalid hook configuration');
 const previousText=await optional(manifestPath);const previous=previousText?json(previousText,'invalid registration JSON'):null;
 if(!remove&&!bound&&!previous&&await optional(path.join(root,'SESSION.md'))!==null)throw Error('an existing SESSION needs explicit --session-id and --document binding; keep direct-read mode until this session is identified');
 const runner=path.join(packageRoot,'.hynix-harness/hooks/session-context.mjs');
 const command=[process.execPath,runner,'--workspace',root].map(quote).join(' ');
 const windows=`powershell.exe -NoLogo -NoProfile -NonInteractive -Command "& ${[process.execPath,runner,'--workspace',root].map(psquote).join(' ')}"`;
 const owned=new Set(previous?.commands||[]);
 if(!remove){
  if(hasInline(await optional(path.join(root,'.codex/config.toml'))))throw Error('project inline hooks need review; keep direct-read mode until merged without duplicates');
  if(path.resolve(codexHome)!==path.join(root,'.codex')){
   const globalRaw=await optional(path.join(codexHome,'hooks.json'));
   if(globalRaw&&commands(json(globalRaw,'invalid user hook JSON')).some(c=>/session-context\.mjs/.test(c)))throw Error('an existing user session hook needs review; no global configuration was changed');
   if(hasInline(await optional(path.join(codexHome,'config.toml'))))throw Error('user inline hooks need review; keep direct-read mode until duplicates are ruled out');
  }
  if(commands(config).some(c=>/session-context\.mjs/.test(c)&&!owned.has(c)))throw Error('an existing project session hook needs review; no hook was replaced');
 }
 const next=structuredClone(config);next.hooks??={};
 for(const event of Object.keys(next.hooks)){
  if(!Array.isArray(next.hooks[event]))throw Error('hook groups must be arrays');
  next.hooks[event]=next.hooks[event].map(group=>({...group,hooks:group.hooks.filter(h=>!owned.has(h.command))})).filter(group=>group.hooks.length);
  if(!next.hooks[event].length)delete next.hooks[event];
 }
 if(!remove)for(const event of EVENTS){
  next.hooks[event]??=[];
  next.hooks[event].push({...(event==='SessionStart'?{matcher:'^(startup|resume|clear|compact)$'}:event==='PostToolUse'?{matcher:'.*'}:{}),hooks:[{type:'command',command,commandWindows:windows,timeout:5,additionalContextLimit:0}]});
 }
 if(remove&&!previous)return {mode:'skills-only',changed:false,reason:'no owned registration'};
 const nextText=JSON.stringify(next,null,2)+'\n';
 if(bound){
  try{
   const dir=await directory(root,'.hynix-harness/runtime/bindings');
   for(const entry of await readdir(dir)){
    if(entry===`${sessionId}.json`||!entry.endsWith('.json'))continue;
    const other=json(await readRegularFile(path.join(dir,entry),8192),'invalid existing binding JSON');
    if(other.document===bound.document)throw Error('this document is already bound to another session; keep its existing identity');
   }
  }catch(e){if(e.code!=='ENOENT')throw e;}
 }
 if(check)return {mode:remove?'skills-only':'hooks-configured-unverified',would_change:nextText!==raw,events:remove?[]:EVENTS,trust:'host review required; not modified',document:bound?.document||null};
 await directory(root,'.codex',{create:true});await directory(root,'.hynix-harness/runtime',{create:true});
 const lock=await open(`${configPath}.hynix.lock`,'wx',0o600);
 try{
  if(await optional(configPath)!==raw||await optional(manifestPath)!==previousText)throw Error('configuration changed; read and reconcile before retry');
  if(raw!==null){
   const backups=await directory(root,'.hynix-harness/runtime/backups',{create:true});const backup=path.join(backups,`hooks-${digest(raw)}.json`);
   try{await writeFile(backup,raw,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;if(await readFile(backup,'utf8')!==raw)throw Error('backup conflict');}
  }
  const manifest={version:1,commands:remove?[]:[command],config_created:previous?.config_created??raw===null,registered_events:remove?[]:EVENTS};
  const empty=Object.keys(next).every(k=>k==='hooks')&&!Object.keys(next.hooks).length;
  if(bound){
   const bindings=await directory(root,'.hynix-harness/runtime/bindings',{create:true});const bf=path.join(bindings,`${sessionId}.json`);const existing=await optional(bf);
   const bt=JSON.stringify(bound,null,2)+'\n';if(existing!==null&&existing!==bt)throw Error('session already bound to a different document');
   if(existing===null)await writeFile(bf,bt,{flag:'wx',mode:0o600});
  }
  await atomic(manifestPath,JSON.stringify(manifest,null,2)+'\n');
  try{
   if(remove&&manifest.config_created&&empty){if(raw!==null)await unlink(configPath);}
   else if(nextText!==raw){const mode=raw===null?0o600:(await lstat(configPath)).mode&0o777;await atomic(configPath,nextText,mode);}
  }catch(e){if(previousText===null)await unlink(manifestPath);else await atomic(manifestPath,previousText);throw e;}
  return {mode:remove?'skills-only':'hooks-configured-unverified',changed:nextText!==raw,events:remove?[]:EVENTS,trust:'host review required; not modified',document:bound?.document||null};
 }finally{await lock.close();await unlink(`${configPath}.hynix.lock`);}
}
if(process.argv[1]&&await realpath(process.argv[1]).catch(()=>null)===await realpath(fileURLToPath(import.meta.url))){
 try{
  const args=process.argv.slice(2);const options={};
  for(let i=0;i<args.length;i++){const a=args[i];if(a==='--remove')options.remove=true;else if(a==='--check')options.check=true;else if(['--workspace','--session-id','--document'].includes(a)){if(!args[i+1]||args[i+1].startsWith('--'))throw Error(`missing ${a}`);options[{'--workspace':'workspace','--session-id':'sessionId','--document':'document'}[a]]=args[++i];}else throw Error(`unknown option ${a}`);}
  if(!options.workspace)throw Error('usage: setup.mjs --workspace <workspace> [--check|--remove] [--session-id <id> --document <SESSION.md>]');
  process.stdout.write(JSON.stringify(await setup(options))+'\n');
 }catch(e){process.stdout.write(JSON.stringify({mode:'skills-only',configured:false,reason:e.message,next:'Read my-session-save and the current SESSION directly; do not install Node or assume automatic delivery.'})+'\n');process.exitCode=1;}
}
