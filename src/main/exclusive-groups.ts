import type {ExclusiveChoices,ExclusiveConflict,ExclusiveGroup} from '../shared/contracts';
export function exclusiveRequests(groups:ExclusiveGroup[],ids:string[],choices:ExclusiveChoices={}):{enabled:Set<string>;conflicts:ExclusiveConflict[]} {
 if(!choices||typeof choices!=='object'||Array.isArray(choices)||Object.values(choices).some(id=>typeof id!=='string'))throw new Error('互斥成员选择格式无效。');
 const enabled=new Set(ids);const conflicts:ExclusiveConflict[]=[];const choiceGroups=new Set<string>();
 for(const group of groups){const candidates=group.modIds.filter(id=>enabled.has(id));
  if(candidates.length<2)continue;choiceGroups.add(group.id);
  if(!Object.hasOwn(choices,group.id)){conflicts.push({groupId:group.id,name:group.name,candidateIds:candidates});continue;}
  if(!candidates.includes(choices[group.id]))throw new Error(`互斥组“${group.name}”的选择不属于本次启用成员。`);
  for(const id of candidates)if(id!==choices[group.id])enabled.delete(id);
 }
 if(Object.keys(choices).some(id=>!choiceGroups.has(id)))throw new Error('互斥选择已经过期，请重新执行操作。');
 return {enabled,conflicts};
}
