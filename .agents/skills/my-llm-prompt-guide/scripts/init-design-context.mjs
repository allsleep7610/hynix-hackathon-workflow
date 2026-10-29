import {readFile,mkdir,writeFile,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const groups=new Set(['workflow','judgment','maintenance','design','learning','life']);
export async function initializeDesignContext(folder,group){
 const root=path.resolve(folder),name=path.basename(root);
 if(!/^[a-z0-9-]{1,63}$/.test(name))throw Error('스킬 폴더 이름을 확인해 주세요.');
 if(group&&!groups.has(group))throw Error('분야는 workflow/judgment/maintenance/design/learning/life 중 하나입니다.');
 const skillPath=path.join(root,'SKILL.md');if(!(await lstat(skillPath)).isFile())throw Error('일반 SKILL.md 파일이 필요합니다.');
 const bytes=await readFile(skillPath),text=bytes.toString('utf8');
 if(!new RegExp('^name: *'+name+' *$','m').test(text))throw Error('폴더 이름과 Skill name이 다릅니다.');
 const reference=path.join(root,'references');await mkdir(reference,{recursive:true});if((await lstat(reference)).isSymbolicLink())throw Error('참조 폴더의 심볼릭 링크를 따라 쓰지 않습니다.');
 const target=path.join(reference,'design-context.md'),hash=createHash('sha256').update(bytes).digest('hex');
 const content='---\nformat: skill-design-context-v1\nskill: '+name+'\nstatus: draft\nskill_source_sha256: '+hash+'\n'+(group?'viewer_group: '+group+'\n':'')+'---\n# 제작 배경\n\n## 만든 니즈\n\n## 참고 기반\n\n## 작동 방식\n\n## 주의점\n';
 try{await writeFile(target,content,{flag:'wx'});return {created:true,path:target,sourceHash:hash}}catch(error){if(error.code==='EEXIST')return {created:false,path:target,reason:'기존 문서를 유지했습니다.'};throw error}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 try{if(!process.argv[2])throw Error('사용법: node init-design-context.mjs <개발 스킬 폴더> [분야]');console.log(JSON.stringify(await initializeDesignContext(process.argv[2],process.argv[3])))}catch(error){console.error(error.message);process.exitCode=1}
}
