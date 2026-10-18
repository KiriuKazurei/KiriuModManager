export const DEFAULT_TAG_COLOR='#4f6bed';

export function normalizeTagColors(tags:readonly string[],input:unknown={}):Record<string,string>{
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length>20)throw new Error('标签颜色格式无效。');
 const colors=input as Record<string,unknown>;
 if(Object.keys(colors).some(name=>!tags.includes(name)))throw new Error('颜色必须对应现有标签。');
 return Object.fromEntries(tags.map(name=>{const color=Object.hasOwn(colors,name)?colors[name]:DEFAULT_TAG_COLOR;if(typeof color!=='string'||!/^#[0-9a-f]{6}$/i.test(color))throw new Error('标签背景色须为六位十六进制颜色。');return [name,color.toLowerCase()];}));
}

export function tagTextColor(background:string){
 const channels=[1,3,5].map(start=>parseInt(background.slice(start,start+2),16)/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);
 const luminance=.2126*channels[0]+.7152*channels[1]+.0722*channels[2];
 return (luminance+.05)/.05>=1.05/(luminance+.05)?'#000000':'#ffffff';
}
