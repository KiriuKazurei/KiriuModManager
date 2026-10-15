// Run with Electron: the same Segoe UI bold glyph and theme tokens as the renderer.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
app.setPath('userData',path.join(root,'.run-data','icon-renderer'));
app.commandLine.appendSwitch('force-device-scale-factor','1');
app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 let window,exitCode=0;
 try{
  const css=await fs.readFile(path.join(root,'src/renderer/styles.css'),'utf8');
  const color=token=>{const value=new RegExp('--'+token+':(#[a-f0-9]{6})','i').exec(css)?.[1];if(!value)throw new Error('Missing theme token '+token);return value;};
  const accent=color('accent'),ink=color('accent-ink');
  const svgFor=border=>`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 36 36"><rect width="36" height="36" fill="${accent}"/><rect x="${border}" y="${border}" width="${36-2*border}" height="${36-2*border}" fill="${ink}"/><text x="18" y="18" dy=".35em" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="24" font-weight="700" fill="${accent}">K</text></svg>\n`;
  const svg=svgFor(2);
  window=new BrowserWindow({width:256,height:256,frame:false,show:false,webPreferences:{sandbox:true,contextIsolation:true}});
  await window.loadURL('data:text/html;charset=utf-8,<meta charset="utf-8">');
  await window.webContents.executeJavaScript('document.fonts.ready.then(()=>true)');
  const sizes=[16,20,24,32,40,48,64,128,256],images=[];
  for(const size of sizes){
   // Align the frame to whole pixels at every native size so corners stay opaque.
   const frameSvg=svgFor(Math.max(1,Math.round(size*2/36))*36/size);
   const data=await window.webContents.executeJavaScript(`(async()=>{const image=new Image();image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(${JSON.stringify(frameSvg)});await image.decode();const canvas=document.createElement('canvas');canvas.width=canvas.height=${size};canvas.getContext('2d').drawImage(image,0,0,${size},${size});return canvas.toDataURL('image/png');})()`);
   const bytes=Buffer.from(data.split(',')[1],'base64');if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('Icon rendering failed');images.push(bytes);
  }
  const header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);let offset=header.length;
  sizes.forEach((size,index)=>{const at=6+index*16;header[at]=size===256?0:size;header[at+1]=header[at];header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(images[index].length,at+8);header.writeUInt32LE(offset,at+12);offset+=images[index].length;});
  await fs.writeFile(path.join(root,'assets/app.svg'),svg);
  await fs.writeFile(path.join(root,'assets/tray.png'),images[sizes.indexOf(32)]);
  await fs.writeFile(path.join(root,'assets/app.ico'),Buffer.concat([header,...images]));
  console.log(JSON.stringify({accent,ink,font:'Segoe UI',weight:700,traySize:32,icoSizes:sizes}));
 }catch(error){console.error(error);exitCode=1;}finally{window?.destroy();app.exit(exitCode);}
});
