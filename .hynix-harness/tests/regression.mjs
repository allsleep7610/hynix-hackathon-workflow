import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

const base=path.dirname(fileURLToPath(import.meta.url));
const candidate=path.resolve(base,'../..');
const execution=await fs.mkdtemp(path.join(os.tmpdir(),'hynix-hook-test-'));
await fs.mkdir(execution,{recursive:true});
const sha=s=>createHash('sha256').update(s).digest('hex');
async function tree(root,relative=''){
 const rows=[];
 for(const item of (await fs.readdir(path.join(root,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  const rel=path.join(relative,item.name);
  if(item.isDirectory())rows.push(...await tree(root,rel));
  else if(item.isSymbolicLink())rows.push([rel,'symlink',await fs.readlink(path.join(root,rel))]);
  else rows.push([rel,sha(await fs.readFile(path.join(root,rel)))]);
 }
 return rows;
}
const fingerprint=await tree(candidate);
await fs.cp(candidate,path.join(execution,'snapshot'),{recursive:true});
assert.deepEqual(await tree(path.join(execution,'snapshot')),fingerprint,'candidate changed during snapshot creation');
const fingerprintHash=sha(JSON.stringify(fingerprint));
const results=[];
async function fixture(name){
 const root=path.join(execution,name),pkg=path.join(root,'pkg'),home=path.join(root,'isolated-codex-home');
 await fs.mkdir(home,{recursive:true});
 await fs.cp(path.join(execution,'snapshot'),pkg,{recursive:true});
 const hook=await import(pathToFileURL(path.join(pkg,'.hynix-harness/hooks/session-context.mjs')));
 const installer=await import(pathToFileURL(path.join(pkg,'.hynix-harness/hooks/setup.mjs')));
 const helper=await import(pathToFileURL(path.join(pkg,'.agents/skills/my-session-save/scripts/session-document.mjs')));
 const blocks=Object.fromEntries(helper.BLOCK_IDS.map(id=>[id,`${id} original\n공백  줄\n\n마지막 줄\t${id}`]));
 const text=helper.renderSession(blocks);
 const event=(kind='SessionStart',session_id='alpha',source='startup')=>({hook_event_name:kind,session_id,source,prompt:'a local prompt',tool_name:'apply_patch'});
 const file=id=>path.join(pkg,'.hynix-harness/runtime/sessions',id,'SESSION.md');
 const cache=id=>path.join(path.dirname(file(id)),'.session-context.json');
 async function seed(id='alpha',body=text){await fs.mkdir(path.dirname(file(id)),{recursive:true});await fs.writeFile(file(id),body);return file(id);}
 const setup=opts=>installer.setup({workspace:pkg,codexHome:home,...opts});
 return {root,pkg,home,hook,helper,installer,blocks,text,event,file,cache,seed,setup};
}
async function test(name,fn){
 try{const f=await fixture(name);const evidence=await fn(f);results.push({name,status:'pass',evidence:evidence??null});}
 catch(e){results.push({name,status:'fail',error:e.stack});}
 await fs.writeFile(path.join(execution,'results.json'),JSON.stringify({candidate,fingerprintHash,fingerprint,results},null,2));
}
const context=r=>r.hookSpecificOutput?.additionalContext??'';
const config=f=>path.join(f.pkg,'.codex/hooks.json');
async function putConfig(f,value){await fs.mkdir(path.dirname(config(f)),{recursive:true});await fs.writeFile(config(f),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');}
async function missing(file){await assert.rejects(fs.stat(file),{code:'ENOENT'});}
function commandHandlers(c){return Object.entries(c.hooks).flatMap(([event,groups])=>groups.flatMap(g=>g.hooks.map(h=>({event,...h}))));}
const readConfig=async f=>JSON.parse(await fs.readFile(config(f),'utf8'));

await test('autocreate-template-byte-preservation',async f=>{
 const template=await fs.readFile(path.join(f.pkg,'templates/SESSION.md'),'utf8');
 const out=await f.hook.run(f.event(),f.pkg);
 assert.equal(await fs.readFile(f.file('alpha'),'utf8'),template);assert.ok(context(out).includes(template));
 assert.ok(context(out).includes('New session document:'));assert.ok(context(out).includes(f.file('alpha')));
 return {canonicalHash:sha(template),path:f.file('alpha')};
});
for(const source of ['startup','resume','clear','compact'])await test(`session-start-${source}-whole`,async f=>{
 await f.seed();await f.hook.run(f.event(),f.pkg);
 const before=await fs.readFile(f.file('alpha'));
 const out=await f.hook.run(f.event('SessionStart','alpha',source),f.pkg);
 assert.ok(context(out).includes(f.text));assert.deepEqual(await fs.readFile(f.file('alpha')),before);
 for(const id of f.helper.BLOCK_IDS)assert.ok(context(out).includes(f.blocks[id]));
});
await test('prompt-unchanged-no-document-body',async f=>{
 await f.seed();await f.hook.run(f.event(),f.pkg);
 const before=await fs.readFile(f.file('alpha'));const out=await f.hook.run(f.event('UserPromptSubmit'),f.pkg);
 assert.equal(context(out),'');assert.deepEqual(await fs.readFile(f.file('alpha')),before);
});
await test('prompt-change-complete-sections-no-other-sections',async f=>{
 await f.seed();await f.hook.run(f.event(),f.pkg);
 const next={...f.blocks,R1:'R1 replacement\n\n  exact trailing  \n두 번째\t',R3:'R3 replacement\nfull end'};
 const text=f.helper.renderSession(next);await fs.writeFile(f.file('alpha'),text);
 const out=await f.hook.run(f.event('UserPromptSubmit'),f.pkg);const c=context(out);
 assert.ok(c.includes(next.R1));assert.ok(c.includes(next.R3));
 for(const id of ['CURRENT','R2','R4'])assert.ok(!c.includes(f.blocks[id]));
 assert.equal(await fs.readFile(f.file('alpha'),'utf8'),text);
 assert.equal(context(await f.hook.run(f.event('UserPromptSubmit'),f.pkg)),'');
});
await test('post-tool-complete-changed-section',async f=>{
 await f.seed();await f.hook.run(f.event(),f.pkg);
 const next={...f.blocks,R4:'R4 tool change\n\nmore complete text  '};const text=f.helper.renderSession(next);
 await fs.writeFile(f.file('alpha'),text);const out=await f.hook.run(f.event('PostToolUse'),f.pkg);
 assert.ok(context(out).includes(next.R4));assert.ok(!context(out).includes(f.blocks.R1));
 assert.equal(await fs.readFile(f.file('alpha'),'utf8'),text);
});
await test('session-isolation',async f=>{
 await f.seed('alpha');const second=f.helper.renderSession({...f.blocks,R1:'BETA PRIVATE OUTPUT'});await f.seed('beta',second);
 assert.ok(context(await f.hook.run(f.event('SessionStart','beta'),f.pkg)).includes('BETA PRIVATE OUTPUT'));
 const alpha=context(await f.hook.run(f.event(),f.pkg));assert.ok(alpha.includes(f.blocks.R1));assert.ok(!alpha.includes('BETA PRIVATE OUTPUT'));
 assert.equal(context(await f.hook.run(f.event('UserPromptSubmit','beta'),f.pkg)),'');
 assert.equal(await fs.readFile(f.file('beta'),'utf8'),second);
});
await test('document-corruption-warns-and-recovers-same-bytes',async f=>{
 await f.seed();await f.hook.run(f.event(),f.pkg);await fs.writeFile(f.file('alpha'),'broken canonical original');
 const bad=await f.hook.run(f.event('PostToolUse'),f.pkg);assert.ok(bad.systemMessage);assert.match(context(bad),/direct|complete document/i);
 assert.equal(await fs.readFile(f.file('alpha'),'utf8'),'broken canonical original');
 await fs.writeFile(f.file('alpha'),f.text);const repaired=await f.hook.run(f.event('UserPromptSubmit'),f.pkg);
 assert.ok(context(repaired).includes(f.text));assert.equal(await fs.readFile(f.file('alpha'),'utf8'),f.text);
});
await test('cache-json-corruption-whole-recovery',async f=>{
 await f.seed();await f.hook.run(f.event(),f.pkg);await fs.writeFile(f.cache('alpha'),'{ invalid');
 const out=await f.hook.run(f.event('UserPromptSubmit'),f.pkg);assert.ok(context(out).includes(f.text));
 assert.equal(context(await f.hook.run(f.event('UserPromptSubmit'),f.pkg)),'');
 assert.equal(await fs.readFile(f.file('alpha'),'utf8'),f.text);
});
await test('cache-symlink-fail-closed-no-target-write',async f=>{
 await f.seed();await f.hook.run(f.event(),f.pkg);const outside=path.join(f.root,'sentinel-cache');await fs.writeFile(outside,'outside cache bytes');
 await fs.unlink(f.cache('alpha'));await fs.symlink(outside,f.cache('alpha'));
 const out=await f.hook.run(f.event('UserPromptSubmit'),f.pkg);assert.ok(out.systemMessage);assert.match(context(out),/Stop affected execution/);
 assert.equal(await fs.readFile(outside,'utf8'),'outside cache bytes');assert.equal(await fs.readFile(f.file('alpha'),'utf8'),f.text);
});
await test('oversize-document-preserved-warn-direct-read',async f=>{
 const huge=f.helper.renderSession({...f.blocks,R4:'z'.repeat(256*1024)});await f.seed('alpha',huge);
 const out=await f.hook.run(f.event(),f.pkg);assert.ok(out.systemMessage);assert.match(context(out),/direct/i);
 assert.ok(!context(out).includes('z'.repeat(100)));assert.equal(await fs.readFile(f.file('alpha'),'utf8'),huge);
});
await test('invalid-session-ids-have-no-runtime-write',async f=>{
 for(const id of ['../escape','a/b','a\\b','..','alpha.','','한글',null,'x'.repeat(129)])await assert.rejects(f.hook.run(f.event('SessionStart',id),f.pkg));
 await missing(path.join(f.pkg,'.hynix-harness/runtime'));
});
await test('invalid-events-have-no-runtime-write',async f=>{
 for(const ev of [f.event('SessionStart','alpha','bogus'),f.event('Bogus'),{...f.event('UserPromptSubmit'),prompt:null},{...f.event('PostToolUse'),tool_name:''}])await assert.rejects(f.hook.run(ev,f.pkg));
 await missing(path.join(f.pkg,'.hynix-harness/runtime'));
});
await test('runtime-directory-symlink-refused',async f=>{
 const target=path.join(f.root,'outside-runtime');await fs.mkdir(target);await fs.symlink(target,path.join(f.pkg,'.hynix-harness/runtime'));
 await assert.rejects(f.hook.run(f.event(),f.pkg));assert.deepEqual(await fs.readdir(target),[]);
});
await test('session-document-symlink-refused-no-outside-read-or-write',async f=>{
 const target=path.join(f.root,'outside-SESSION.md');await fs.writeFile(target,f.text);await fs.mkdir(path.dirname(f.file('alpha')),{recursive:true});await fs.symlink(target,f.file('alpha'));
 const out=await f.hook.run(f.event(),f.pkg);assert.ok(out.systemMessage);assert.ok(!context(out).includes(f.blocks.R1));assert.equal(await fs.readFile(target,'utf8'),f.text);
});
await test('helper-replaceBlock-preserves-other-original-sections',async f=>{
 await f.seed();const replacement='new full R3\n  exact  \n\n끝\t';await f.helper.replaceBlock(f.file('alpha'),'R3',replacement,f.helper.digest(f.text));
 const text=await fs.readFile(f.file('alpha'),'utf8');assert.equal(text,f.helper.renderSession({...f.blocks,R3:replacement}));
 for(const id of ['CURRENT','R1','R2','R4'])assert.equal(f.helper.parseSession(text)[id].body,f.blocks[id]);
});
await test('helper-stalehash-and-lock-reject-without-overwrite',async f=>{
 await f.seed();await assert.rejects(f.helper.replaceBlock(f.file('alpha'),'R1','stale write','bad hash'));assert.equal(await fs.readFile(f.file('alpha'),'utf8'),f.text);
 await fs.writeFile(f.file('alpha')+'.lock','other writer');await assert.rejects(f.helper.replaceBlock(f.file('alpha'),'R1','locked write',f.helper.digest(f.text)),{code:'EEXIST'});
 assert.equal(await fs.readFile(f.file('alpha'),'utf8'),f.text);assert.equal(await fs.readFile(f.file('alpha')+'.lock','utf8'),'other writer');
});
await test('setup-three-events-current-node-existing-hooks-backup-idempotence-remove',async f=>{
 const original={extra:{keep:'top-level'},hooks:{PreToolUse:[{matcher:'safe',hooks:[{type:'command',command:'echo KEEP_PRE',timeout:7}]}],SessionStart:[{matcher:'startup',hooks:[{type:'command',command:'echo KEEP_START'}]}]}};
 const raw=JSON.stringify(original,null,3)+'\n';await putConfig(f,raw);const check=await f.setup({check:true});assert.ok(check.would_change);assert.equal(await fs.readFile(config(f),'utf8'),raw);
 await f.setup();const after=await readConfig(f);assert.deepEqual(after.extra,original.extra);assert.deepEqual(after.hooks.PreToolUse,original.hooks.PreToolUse);
 assert.deepEqual(after.hooks.SessionStart[0],original.hooks.SessionStart[0]);
 const owned=commandHandlers(after).filter(h=>h.command.includes('session-context.mjs'));assert.equal(owned.length,3);
 for(const h of owned){assert.ok(h.command.includes(process.execPath));assert.ok(h.command.includes(f.pkg));}
 assert.deepEqual(owned.map(h=>h.event).sort(),['PostToolUse','SessionStart','UserPromptSubmit']);
 const backupDir=path.join(f.pkg,'.hynix-harness/runtime/backups');const backups=await fs.readdir(backupDir);assert.ok((await Promise.all(backups.map(b=>fs.readFile(path.join(backupDir,b),'utf8')))).includes(raw));
 const first=await fs.readFile(config(f),'utf8');const repeat=await f.setup();assert.equal(repeat.changed,false);assert.equal(await fs.readFile(config(f),'utf8'),first);
 await f.seed();await f.setup({remove:true});assert.deepEqual(await readConfig(f),original);assert.equal(await fs.readFile(f.file('alpha'),'utf8'),f.text);
 assert.equal((await f.setup({remove:true})).changed,false);
 return {registeredEvents:owned.map(h=>h.event),node:process.execPath};
});
await test('setup-new-config-removal-retains-session',async f=>{
 await f.setup();await f.seed();await f.setup({remove:true});await missing(config(f));assert.equal(await fs.readFile(f.file('alpha'),'utf8'),f.text);
});
for(const kind of ['project-session','project-inline','user-session','user-inline'])await test(`setup-conflict-${kind}-no-mutation`,async f=>{
 if(kind==='project-session')await putConfig(f,{hooks:{SessionStart:[{hooks:[{command:"node '/old/session-context.mjs'"}]}]}});
 if(kind==='project-inline'){await fs.mkdir(path.join(f.pkg,'.codex'));await fs.writeFile(path.join(f.pkg,'.codex/config.toml'),'[hooks]\nkeep = true\n');}
 if(kind==='user-session')await fs.writeFile(path.join(f.home,'hooks.json'),JSON.stringify({hooks:{SessionStart:[{hooks:[{command:'node /old/session-context.mjs'}]}]}}));
 if(kind==='user-inline')await fs.writeFile(path.join(f.home,'config.toml'),'[[hooks.SessionStart]]\nkeep = true\n');
 const before=await tree(f.root);await assert.rejects(f.setup());assert.deepEqual(await tree(f.root),before);
 const cli=spawnSync(process.execPath,[path.join(f.pkg,'.hynix-harness/hooks/setup.mjs'),'--workspace',f.pkg],{cwd:f.root,env:{PATH:path.dirname(process.execPath),CODEX_HOME:f.home,HOME:process.env.HOME},encoding:'utf8'});
 assert.equal(cli.status,1);assert.equal(JSON.parse(cli.stdout).mode,'skills-only');assert.deepEqual(await tree(f.root),before);
});
await test('setup-does-not-change-trust-configs',async f=>{
 const project='[projects.example]\ntrust_level = "untrusted"\n';const user='[projects.other]\ntrust_level = "trusted"\n';
 await fs.mkdir(path.join(f.pkg,'.codex'));await fs.writeFile(path.join(f.pkg,'.codex/config.toml'),project);await fs.writeFile(path.join(f.home,'config.toml'),user);
 await f.setup();assert.equal(await fs.readFile(path.join(f.pkg,'.codex/config.toml'),'utf8'),project);assert.equal(await fs.readFile(path.join(f.home,'config.toml'),'utf8'),user);
});
await test('setup-cli-unrelated-cwd-and-invocable-hook',async f=>{
 const cli=spawnSync(process.execPath,[path.join(f.pkg,'.hynix-harness/hooks/setup.mjs'),'--workspace',f.pkg],{cwd:f.home,env:{PATH:path.dirname(process.execPath),CODEX_HOME:f.home,HOME:process.env.HOME},encoding:'utf8'});
 assert.equal(cli.status,0,cli.stdout+cli.stderr);assert.equal(JSON.parse(cli.stdout).mode,'hooks-configured-unverified');
 const handler=commandHandlers(await readConfig(f)).find(h=>h.event==='SessionStart');
 const hookCli=spawnSync('/bin/sh',['-c',handler.command],{cwd:f.home,input:JSON.stringify(f.event()),env:{PATH:path.dirname(process.execPath),CODEX_HOME:f.home,HOME:process.env.HOME},encoding:'utf8'});
 assert.equal(hookCli.status,0,hookCli.stderr);const out=JSON.parse(hookCli.stdout);assert.ok(context(out).includes(await fs.readFile(f.file('alpha'),'utf8')));
});
await test('explicit-binding-same-canonical-no-copy-and-remove-preserves',async f=>{
 const existing=path.join(f.pkg,'existing/SESSION.md');await fs.mkdir(path.dirname(existing));await fs.writeFile(existing,f.text);
 const initial=await fs.stat(existing);await f.setup({sessionId:'wireid',document:'existing/SESSION.md'});
 const location=await f.hook.documentPath(f.pkg,'wireid');assert.equal(location.file,existing);assert.equal(location.created,false);
 assert.ok(context(await f.hook.run(f.event('SessionStart','wireid'),f.pkg)).includes(f.text));await missing(f.file('wireid'));
 const updated=f.helper.renderSession({...f.blocks,R2:'UPDATED DIRECT READ CANONICAL'});await fs.writeFile(existing,updated);
 const out=await f.hook.run(f.event('UserPromptSubmit','wireid'),f.pkg);assert.ok(context(out).includes('UPDATED DIRECT READ CANONICAL'));
 await f.setup({remove:true});assert.equal(await fs.readFile(existing,'utf8'),updated);assert.equal((await fs.stat(existing)).ino,initial.ino);await missing(f.file('wireid'));
});
await test('setup-workspace-above-package-supported',async f=>{
 await f.setup({workspace:f.root});const cfg=JSON.parse(await fs.readFile(path.join(f.root,'.codex/hooks.json'),'utf8'));
 const handler=commandHandlers(cfg).find(h=>h.event==='SessionStart');
 const cli=spawnSync('/bin/sh',['-c',handler.command],{cwd:f.home,input:JSON.stringify(f.event()),env:{CODEX_HOME:f.home,HOME:process.env.HOME,PATH:path.dirname(process.execPath)},encoding:'utf8'});
 assert.equal(cli.status,0,cli.stderr);assert.ok(context(JSON.parse(cli.stdout)).includes(path.join(f.root,'.hynix-harness/runtime/sessions/alpha/SESSION.md')));
});
for(const kind of ['outside','symlink','different-binding'])await test(`binding-reject-${kind}-no-canonical-change`,async f=>{
 const existing=path.join(f.pkg,'existing/SESSION.md');await fs.mkdir(path.dirname(existing));await fs.writeFile(existing,f.text);
 if(kind==='outside'){const out=path.join(f.root,'SESSION.md');await fs.writeFile(out,f.text);await assert.rejects(f.setup({sessionId:'wireid',document:out}));}
 if(kind==='symlink'){await fs.symlink(existing,path.join(f.pkg,'SESSION.md'));await assert.rejects(f.setup({sessionId:'wireid',document:'SESSION.md'}));}
 if(kind==='different-binding'){
  await f.setup({sessionId:'wireid',document:'existing/SESSION.md'});await fs.writeFile(path.join(f.pkg,'SESSION.md'),f.text);
  const before=await fs.readFile(config(f),'utf8');await assert.rejects(f.setup({sessionId:'wireid',document:'SESSION.md'}));assert.equal(await fs.readFile(config(f),'utf8'),before);
 }
 assert.equal(await fs.readFile(existing,'utf8'),f.text);
});
await test('setup-malformed-config-lock-and-symlink-no-overwrite',async f=>{
 await putConfig(f,'{ bad json');const before=await tree(f.pkg);await assert.rejects(f.setup());assert.deepEqual(await tree(f.pkg),before);
 await putConfig(f,{});await fs.writeFile(config(f)+'.hynix.lock','another process');await assert.rejects(f.setup(),{code:'EEXIST'});assert.equal(await fs.readFile(config(f),'utf8'),'{}\n');
 await fs.unlink(config(f)+'.hynix.lock');await fs.unlink(config(f));const outside=path.join(f.root,'outside-hooks.json');await fs.writeFile(outside,'{}');await fs.symlink(outside,config(f));
 await assert.rejects(f.setup());assert.equal(await fs.readFile(outside,'utf8'),'{}');
});
await test('cache-gap-B-to-A-restoration-reemits-original',async f=>{
 await f.seed();await f.hook.run(f.event(),f.pkg);
 const b=f.helper.renderSession({...f.blocks,R2:'intermediate B canonical'});await fs.writeFile(f.file('alpha'),b);
 await fs.unlink(f.cache('alpha'));await fs.mkdir(f.cache('alpha'));
 const failed=await f.hook.run(f.event('PostToolUse'),f.pkg);assert.ok(failed.systemMessage);assert.match(context(failed),/Stop affected execution/);
 await fs.rmdir(f.cache('alpha'));await fs.writeFile(f.file('alpha'),f.text);
 const restored=await f.hook.run(f.event('UserPromptSubmit'),f.pkg);assert.ok(context(restored).includes(f.text));
 assert.equal(await fs.readFile(f.file('alpha'),'utf8'),f.text);
});
await test('cache-oversize-recovery-preserves-canonical',async f=>{
 await f.seed();await f.hook.run(f.event(),f.pkg);await fs.writeFile(f.cache('alpha'),' '.repeat(8193));
 const out=await f.hook.run(f.event('PostToolUse'),f.pkg);assert.ok(context(out).includes(f.text));assert.ok(out.systemMessage);
 assert.equal(await fs.readFile(f.file('alpha'),'utf8'),f.text);assert.equal(context(await f.hook.run(f.event('UserPromptSubmit'),f.pkg)),'');
});
await test('canonical-crlf-delivery-preserves-original-bytes',async f=>{
 const original=f.text.replaceAll('\n','\r\n');await f.seed('alpha',original);
 const out=await f.hook.run(f.event(),f.pkg);assert.ok(context(out).includes(original));assert.equal(await fs.readFile(f.file('alpha'),'utf8'),original);
 const body='R2 replacement\r\n\r\n line with spaces  \r\n';await f.helper.replaceBlock(f.file('alpha'),'R2',body,f.helper.digest(original));
 const updated=await fs.readFile(f.file('alpha'),'utf8');const delivered=context(await f.hook.run(f.event('PostToolUse'),f.pkg));assert.ok(delivered.includes(body));
 for(const id of ['CURRENT','R1','R3','R4'])assert.equal(f.helper.parseSession(updated)[id].body,f.helper.parseSession(original)[id].body);
});
await test('binding-missing-or-malformed-document-warns-and-recovers',async f=>{
 const existing=path.join(f.pkg,'existing/SESSION.md');await fs.mkdir(path.dirname(existing));await fs.writeFile(existing,f.text);
 await f.setup({sessionId:'wireid',document:'existing/SESSION.md'});await f.hook.run(f.event('SessionStart','wireid'),f.pkg);
 await fs.unlink(existing);const gone=await f.hook.run(f.event('UserPromptSubmit','wireid'),f.pkg);assert.ok(gone.systemMessage);assert.match(context(gone),/direct/i);await missing(existing);await missing(f.file('wireid'));
 await fs.writeFile(existing,'original malformed evidence');const bad=await f.hook.run(f.event('PostToolUse','wireid'),f.pkg);assert.ok(bad.systemMessage);assert.equal(await fs.readFile(existing,'utf8'),'original malformed evidence');
 await fs.writeFile(existing,f.text);assert.ok(context(await f.hook.run(f.event('UserPromptSubmit','wireid'),f.pkg)).includes(f.text));
});
await test('binding-path-traversal-and-symlink-runtime-refused',async f=>{
 const bindings=path.join(f.pkg,'.hynix-harness/runtime/bindings');await fs.mkdir(bindings,{recursive:true});
 const outside=path.join(f.root,'SESSION.md');await fs.writeFile(outside,'OUTSIDE PRIVATE SENTINEL');
 for(const document of ['../../../../SESSION.md',outside]){
  await fs.writeFile(path.join(bindings,'wireid.json'),JSON.stringify({session_id:'wireid',document}));
  await assert.rejects(f.hook.run(f.event('SessionStart','wireid'),f.pkg));assert.equal(await fs.readFile(outside,'utf8'),'OUTSIDE PRIVATE SENTINEL');
 }
 await fs.unlink(path.join(bindings,'wireid.json'));await fs.rmdir(bindings);const target=path.join(f.root,'outside-bindings');await fs.mkdir(target);await fs.symlink(target,bindings);
 await assert.rejects(f.hook.run(f.event('SessionStart','wireid'),f.pkg));assert.deepEqual(await fs.readdir(target),[]);
});
await test('setup-check-explicit-binding-is-read-only',async f=>{
 const existing=path.join(f.pkg,'existing/SESSION.md');await fs.mkdir(path.dirname(existing));await fs.writeFile(existing,f.text);const before=await tree(f.root);
 const out=await f.setup({check:true,sessionId:'wireid',document:'existing/SESSION.md'});assert.equal(out.document,'existing/SESSION.md');assert.deepEqual(await tree(f.root),before);
});
await test('setup-remove-preserves-hooks-added-after-registration',async f=>{
 await f.setup();const cfg=await readConfig(f);cfg.hooks.SessionStart[0].hooks.push({type:'command',command:'echo ADDED_AFTER'});cfg.hooks.CustomEvent=[{hooks:[{type:'command',command:'echo EXTRA'}]}];await putConfig(f,cfg);
 await f.setup({remove:true});const remaining=commandHandlers(await readConfig(f));assert.deepEqual(remaining.map(h=>h.command).sort(),['echo ADDED_AFTER','echo EXTRA']);
});
await test("setup paths with spaces and 'quotes'",async f=>{
 await f.setup();const cfg=await readConfig(f);const handler=commandHandlers(cfg).find(h=>h.event==='SessionStart');
 const cli=spawnSync('/bin/sh',['-c',handler.command],{cwd:f.home,input:JSON.stringify(f.event()),env:{CODEX_HOME:f.home,HOME:process.env.HOME,PATH:path.dirname(process.execPath)},encoding:'utf8'});
 assert.equal(cli.status,0,cli.stderr);assert.ok(context(JSON.parse(cli.stdout)).includes(await fs.readFile(f.file('alpha'),'utf8')));
});
await test('hook-cli-failures-explicit-direct-read-and-no-state',async f=>{
 const cli=spawnSync(process.execPath,[path.join(f.pkg,'.hynix-harness/hooks/session-context.mjs'),'--workspace',f.pkg],{cwd:f.home,input:JSON.stringify(f.event('SessionStart','../escape')),env:{CODEX_HOME:f.home,HOME:process.env.HOME,PATH:path.dirname(process.execPath)},encoding:'utf8'});
 assert.equal(cli.status,1);assert.equal(cli.stdout,'');assert.match(cli.stderr,/direct-read/);await missing(path.join(f.pkg,'.hynix-harness/runtime'));
});
await test('setup-cli-explicit-binding-canonical-and-fallback-continuity',async f=>{
 const existing=path.join(f.pkg,'existing/SESSION.md');await fs.mkdir(path.dirname(existing));await fs.writeFile(existing,f.text);
 const env={CODEX_HOME:f.home,HOME:process.env.HOME,PATH:path.dirname(process.execPath)};
 const cli=spawnSync(process.execPath,[path.join(f.pkg,'.hynix-harness/hooks/setup.mjs'),'--workspace',f.pkg,'--session-id','wireid','--document','existing/SESSION.md'],{cwd:f.home,env,encoding:'utf8'});
 assert.equal(cli.status,0,cli.stdout+cli.stderr);assert.equal(JSON.parse(cli.stdout).document,'existing/SESSION.md');
 const handler=commandHandlers(await readConfig(f)).find(h=>h.event==='SessionStart');
 const output=spawnSync('/bin/sh',['-c',handler.command],{cwd:f.home,input:JSON.stringify(f.event('SessionStart','wireid')),env,encoding:'utf8'});
 assert.equal(output.status,0,output.stderr);assert.ok(context(JSON.parse(output.stdout)).includes(f.text));await missing(f.file('wireid'));
 const removed=spawnSync(process.execPath,[path.join(f.pkg,'.hynix-harness/hooks/setup.mjs'),'--workspace',f.pkg,'--remove'],{cwd:f.home,env,encoding:'utf8'});
 assert.equal(removed.status,0,removed.stdout+removed.stderr);assert.equal(await fs.readFile(existing,'utf8'),f.text);await missing(f.file('wireid'));
 const direct=f.helper.parseSession(await fs.readFile(existing,'utf8'));for(const id of f.helper.BLOCK_IDS)assert.equal(direct[id].body,f.blocks[id]);
});
await test('setup-existing-root-session-requires-explicit-binding-no-mutation',async f=>{
 const original=path.join(f.pkg,'SESSION.md');await fs.writeFile(original,f.text);const before=await tree(f.root);
 await assert.rejects(f.setup(),/explicit.*binding/);assert.deepEqual(await tree(f.root),before);
 await assert.rejects(f.setup({check:true}),/explicit.*binding/);assert.deepEqual(await tree(f.root),before);
 const env={CODEX_HOME:f.home,HOME:process.env.HOME,PATH:path.dirname(process.execPath)};
 const cli=spawnSync(process.execPath,[path.join(f.pkg,'.hynix-harness/hooks/setup.mjs'),'--workspace',f.pkg],{cwd:f.home,env,encoding:'utf8'});
 assert.equal(cli.status,1);assert.equal(JSON.parse(cli.stdout).mode,'skills-only');assert.deepEqual(await tree(f.root),before);
 await f.setup({sessionId:'wireid',document:'SESSION.md'});assert.equal((await f.hook.documentPath(f.pkg,'wireid')).file,original);
 assert.ok(context(await f.hook.run(f.event('SessionStart','wireid'),f.pkg)).includes(f.text));assert.equal(await fs.readFile(original,'utf8'),f.text);await missing(f.file('wireid'));
});
await test('binding-one-document-one-session-id-no-mutation',async f=>{
 const original=path.join(f.pkg,'existing/SESSION.md');await fs.mkdir(path.dirname(original));await fs.writeFile(original,f.text);
 await f.setup({sessionId:'wireid',document:'existing/SESSION.md'});const before=await tree(f.root);
 for(const document of ['existing/SESSION.md','./existing/SESSION.md','existing/../existing/SESSION.md']){
  await assert.rejects(f.setup({sessionId:'secondid',document}),/already bound to another session/);assert.deepEqual(await tree(f.root),before);
  await assert.rejects(f.setup({check:true,sessionId:'secondid',document}),/already bound to another session/);assert.deepEqual(await tree(f.root),before);
 }
 await f.setup({remove:true});const afterRemoval=await tree(f.root);await assert.rejects(f.setup({sessionId:'secondid',document:'existing/SESSION.md'}),/already bound to another session/);assert.deepEqual(await tree(f.root),afterRemoval);
 assert.equal(await fs.readFile(original,'utf8'),f.text);await missing(f.file('wireid'));await missing(f.file('secondid'));
});
await test('setup-and-hook-cli-symlink-entrypoint-executes',async f=>{
 const alias=path.join(f.root,'package-alias');await fs.symlink(f.pkg,alias);const env={CODEX_HOME:f.home,HOME:process.env.HOME,PATH:path.dirname(process.execPath)};
 const setupCli=spawnSync(process.execPath,[path.join(alias,'.hynix-harness/hooks/setup.mjs'),'--workspace',alias],{cwd:f.home,env,encoding:'utf8'});
 assert.equal(setupCli.status,0,setupCli.stdout+setupCli.stderr);assert.equal(JSON.parse(setupCli.stdout).mode,'hooks-configured-unverified');assert.equal(commandHandlers(await readConfig(f)).filter(h=>h.command.includes('session-context.mjs')).length,3);
 const hookCli=spawnSync(process.execPath,[path.join(alias,'.hynix-harness/hooks/session-context.mjs'),'--workspace',alias],{cwd:f.home,env,input:JSON.stringify(f.event()),encoding:'utf8'});
 assert.equal(hookCli.status,0,hookCli.stderr);assert.ok(context(JSON.parse(hookCli.stdout)).includes(await fs.readFile(f.file('alpha'),'utf8')));
 const removeCli=spawnSync(process.execPath,[path.join(alias,'.hynix-harness/hooks/setup.mjs'),'--workspace',alias,'--remove'],{cwd:f.home,env,encoding:'utf8'});
 assert.equal(removeCli.status,0,removeCli.stdout+removeCli.stderr);assert.equal(JSON.parse(removeCli.stdout).mode,'skills-only');await missing(config(f));assert.ok(await fs.readFile(f.file('alpha'),'utf8'));
});
for(const source of ['hook-input','project-hooks','user-hooks','registration','binding'])await test(`malformed-json-${source}-does-not-disclose-input-snippet`,async f=>{
 const secret='PRIVATE_MALFORMED_JSON_SENTINEL';const malformed=`{${secret} :`;
 const env={CODEX_HOME:f.home,HOME:process.env.HOME,PATH:path.dirname(process.execPath)};
 let script='setup.mjs',input='';
 if(source==='hook-input'){script='session-context.mjs';input=malformed;}
 if(source==='project-hooks')await putConfig(f,malformed);
 if(source==='user-hooks')await fs.writeFile(path.join(f.home,'hooks.json'),malformed);
 if(source==='registration'){await fs.mkdir(path.join(f.pkg,'.hynix-harness/runtime'),{recursive:true});await fs.writeFile(path.join(f.pkg,'.hynix-harness/runtime/registration.json'),malformed);}
 if(source==='binding'){
  script='session-context.mjs';input=JSON.stringify(f.event());await fs.mkdir(path.join(f.pkg,'.hynix-harness/runtime/bindings'),{recursive:true});await fs.writeFile(path.join(f.pkg,'.hynix-harness/runtime/bindings/alpha.json'),malformed);
 }
 const before=await tree(f.root);const cli=spawnSync(process.execPath,[path.join(f.pkg,'.hynix-harness/hooks',script),'--workspace',f.pkg],{cwd:f.home,env,input,encoding:'utf8'});
 assert.equal(cli.status,1);assert.ok(!`${cli.stdout}\n${cli.stderr}`.includes(secret));assert.match(`${cli.stdout}\n${cli.stderr}`,/invalid.*JSON/);assert.deepEqual(await tree(f.root),before);
});
const candidateAfter=await tree(candidate);const final={candidate,fingerprintHash,fingerprint,candidateUnchangedDuringRun:JSON.stringify(candidateAfter)===JSON.stringify(fingerprint),afterFingerprintHash:sha(JSON.stringify(candidateAfter)),results,passed:results.filter(r=>r.status==='pass').length,failed:results.filter(r=>r.status==='fail').length,scope:'isolated API/CLI execution regression, not independent R6 or real exam support proof'};
await fs.writeFile(path.join(execution,'results.json'),JSON.stringify(final,null,2)+'\n');
await fs.writeFile(path.join(execution,'latest.json'),JSON.stringify({execution,result:path.join(execution,'results.json'),fingerprintHash,passed:final.passed,failed:final.failed},null,2)+'\n');
console.log(JSON.stringify({execution,fingerprintHash,passed:final.passed,failed:final.failed,candidateUnchangedDuringRun:final.candidateUnchangedDuringRun,failures:results.filter(r=>r.status==='fail').map(({name,error})=>({name,error}))},null,2));
process.exitCode=final.failed?1:0;
