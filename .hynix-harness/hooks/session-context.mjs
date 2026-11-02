import {mkdir,lstat,realpath,open} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {constants} from 'node:fs';
import {readRegularFile,parseSession,sessionContext} from '../../.agents/skills/my-session-save/scripts/session-document.mjs';

export const SESSION_ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function json(text,label){try{return JSON.parse(text);}catch{throw Error(label);}}
export const inside=(root,target)=>{const r=path.relative(root,target);return r===''||(!r.startsWith(`..${path.sep}`)&&r!=='..'&&!path.isAbsolute(r));};
export function validId(id){if(typeof id!=='string'||!SESSION_ID.test(id)||id.endsWith('.'))throw Error('invalid session_id');return id;}
export async function directory(root,relative,{create=false}={}){
 let current=root;
 for(const part of relative.split(/[\\/]/).filter(Boolean)){
  if(part==='.'||part==='..')throw Error('invalid directory segment');
  current=path.join(current,part);
  if(create)await mkdir(current,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
  const s=await lstat(current);
  if(!s.isDirectory()||s.isSymbolicLink())throw Error('directory is not a regular workspace directory');
 }
 return current;
}
export async function documentPath(workspace,id,{create=false}={}){
 validId(id);
 const runtime=await directory(workspace,'.hynix-harness/runtime',{create});
 const bindingFile=path.join(runtime,'bindings',`${id}.json`);
 let binding=null;
 try{await directory(workspace,'.hynix-harness/runtime/bindings');binding=await readRegularFile(bindingFile,8192);}catch(e){if(e.code!=='ENOENT')throw e;}
 if(binding){
  const value=json(binding,'invalid session binding JSON');
  if(value.session_id!==id||typeof value.document!=='string'||path.isAbsolute(value.document))throw Error('invalid session binding');
  const target=path.resolve(workspace,value.document);
  if(!inside(workspace,target)||path.basename(target)!=='SESSION.md')throw Error('session binding outside workspace');
  await directory(workspace,path.relative(workspace,path.dirname(target)));
  return {file:target,created:false};
 }
 const dir=await directory(workspace,`.hynix-harness/runtime/sessions/${id}`,{create});
 const file=path.join(dir,'SESSION.md');let created=false;
 if(create){
  const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
  const template=await readRegularFile(path.join(packageRoot,'templates/SESSION.md'));parseSession(template);
  let h;
  try{h=await open(file,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);await h.writeFile(template,'utf8');created=true;}
  catch(e){if(e.code!=='EEXIST')throw e;}
  finally{await h?.close();}
 }
 // Parsing and recovery messaging are handled by the shared sessionContext.
 return {file,created};
}
export async function run(input,workspace){
 validId(input?.session_id);
 const event=input.hook_event_name;
 if(event==='SessionStart'){if(!['startup','resume','clear','compact'].includes(input.source))throw Error('invalid SessionStart source');}
 else if(event==='UserPromptSubmit'){if(typeof input.prompt!=='string')throw Error('invalid UserPromptSubmit prompt');}
 else if(event==='PostToolUse'){if(typeof input.tool_name!=='string'||!input.tool_name.trim())throw Error('invalid PostToolUse tool_name');}
 else throw Error('unsupported hook event');
 const root=await realpath(workspace);
 if(!(await lstat(root)).isDirectory())throw Error('workspace is not a directory');
 const location=await documentPath(root,input.session_id,{create:true});
 const session=await sessionContext(input,path.dirname(location.file));
 const instruction=location.created
  ? `New session document: ${location.file}. Restore only confirmed outputs verifiable from this session; do not infer approvals or inherit another session.`
  : event==='SessionStart'?`Read directly if delivery is incomplete. Session document: ${location.file}.`:null;
 const context=[instruction,session.context].filter(Boolean).join('\n\n');
 return {hookSpecificOutput:{hookEventName:event,...(context?{additionalContext:context}:{})},...(session.warning?{systemMessage:session.warning}:{})};
}
if(process.argv[1]&&await realpath(process.argv[1]).catch(()=>null)===await realpath(fileURLToPath(import.meta.url))){
 try{
  const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--workspace')throw Error('usage: session-context.mjs --workspace <workspace>');
  const chunks=[];let length=0;
  for await(const c of process.stdin){length+=c.length;if(length>1024*1024)throw Error('hook input too large');chunks.push(c);}
  const input=json(Buffer.concat(chunks).toString('utf8'),'invalid hook input JSON');
  process.stdout.write(JSON.stringify(await run(input,args[1]))+'\n');
 }catch(e){process.stderr.write(`hynix-session: ${e.message}. Use the session-save direct-read path; do not assume context delivery succeeded.\n`);process.exitCode=1;}
}
