/* Local comic text removal and one shared renderer for preview and PNG export. */
(() => {
  'use strict';
  const makeCanvas = (w, h) => Object.assign(document.createElement('canvas'), {width:w,height:h});
  const pixelBox = (r, w, h, pad=0) => {
    const x=Math.max(0,Math.floor(r.x*w-pad)), y=Math.max(0,Math.floor(r.y*h-pad));
    return {x,y,w:Math.max(1,Math.min(w,Math.ceil((r.x+r.w)*w+pad))-x),h:Math.max(1,Math.min(h,Math.ceil((r.y+r.h)*h+pad))-y)};
  };
  const isLight = (d,i) => Math.min(d[i*4],d[i*4+1],d[i*4+2]) >= 225;

  // A balloon's light interior surrounds glyphs. Fill enclosed glyph holes only;
  // the outer ink contour remains connected to the exterior and is never filled.
  function cleanText(original, sources, options={}) {
    const w=original.width,h=original.height, ctx=original.getContext('2d',{willReadFrequently:true});
    const input=ctx.getImageData(0,0,w,h),data=input.data, result=new Uint8ClampedArray(data);
    const labels=new Int32Array(w*h),queue=new Int32Array(w*h),components=[],bubbleBySource={},warnings=[];
    let nextLabel=0,removed=0;
    function flood(seed) {
      if(labels[seed])return components[labels[seed]-1];
      const id=++nextLabel,points=[];let head=0,tail=1,minX=w,minY=h,maxX=0,maxY=0;
      queue[0]=seed;labels[seed]=id;
      while(head<tail){const p=queue[head++],x=p%w,y=Math.floor(p/w);points.push(p);minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);
        const visit=n=>{if(!labels[n]&&isLight(data,n)){labels[n]=id;queue[tail++]=n}};
        if(x)visit(p-1);if(x<w-1)visit(p+1);if(y)visit(p-w);if(y<h-1)visit(p+w);
      }
      const c={id,points,x:minX,y:minY,w:maxX-minX+1,h:maxY-minY+1};components.push(c);return c;
    }
    function findBalloon(r) {
      const b=pixelBox(r,w,h),candidates=new Map();
      for(const fy of [.5,.25,.75,.1,.9])for(const fx of [.5,.25,.75,.1,.9]){
        const x=Math.min(w-1,b.x+Math.floor(fx*b.w)),y=Math.min(h-1,b.y+Math.floor(fy*b.h)),p=y*w+x;
        if(!isLight(data,p))continue;const c=flood(p);candidates.set(c.id,c);
      }
      const list=[...candidates.values()].filter(c=>c.points.length>Math.max(100,b.w*b.h*.25)&&c.points.length<w*h*.24&&c.w>w*.025&&c.h>h*.015&&c.points.length/(c.w*c.h)>.32);
      return list.sort((a,b)=>b.points.length-a.points.length)[0]||null;
    }
    const processed=new Map();
    function processBalloon(c) {
      if(processed.has(c.id))return processed.get(c.id);
      const bw=c.w,bh=c.h,size=bw*bh,white=new Uint8Array(size),outside=new Uint8Array(size),localQueue=new Int32Array(size);
      for(const p of c.points)white[(Math.floor(p/w)-c.y)*bw+(p%w-c.x)]=1;
      let head=0,tail=0;const push=p=>{if(!white[p]&&!outside[p]){outside[p]=1;localQueue[tail++]=p}};
      for(let x=0;x<bw;x++){push(x);push((bh-1)*bw+x)}for(let y=0;y<bh;y++){push(y*bw);push(y*bw+bw-1)}
      while(head<tail){const p=localQueue[head++],x=p%bw,y=Math.floor(p/bw);if(x)push(p-1);if(x<bw-1)push(p+1);if(y)push(p-bw);if(y<bh-1)push(p+bw)}
      const interior=new Uint8Array(size),glyph=new Uint8Array(size);let count=0;
      for(let p=0;p<size;p++){interior[p]=outside[p]?0:1;if(!white[p]&&!outside[p]){glyph[p]=1;count++}}
      // Remove JPEG/antialiasing fringes around glyphs, constrained to the interior.
      const mask=glyph.slice();for(let p=0;p<size;p++)if(glyph[p]){const x=p%bw,y=Math.floor(p/bw);for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){const nx=x+dx,ny=y+dy;if(nx>=0&&ny>=0&&nx<bw&&ny<bh){const q=ny*bw+nx;if(interior[q])mask[q]=1}}}
      for(let p=0;p<size;p++)if(mask[p]){
        const x=p%bw,y=Math.floor(p/bw);let sum=[0,0,0],n=0;
        for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=bw||ny>=bh)continue;const q=ny*bw+nx;if(white[q]&&!mask[q]){const g=((ny+c.y)*w+nx+c.x)*4;sum[0]+=data[g];sum[1]+=data[g+1];sum[2]+=data[g+2];n++}}
        const g=((y+c.y)*w+x+c.x)*4;result[g]=n?Math.round(sum[0]/n):255;result[g+1]=n?Math.round(sum[1]/n):255;result[g+2]=n?Math.round(sum[2]/n):255;removed++;
      }
      // Largest rectangle inside the balloon gives a natural initial text layout.
      const heights=new Int32Array(bw);let best={area:0,x:0,y:0,w:0,h:0};
      for(let y=0;y<bh;y++){for(let x=0;x<bw;x++)heights[x]=interior[y*bw+x]?heights[x]+1:0;const stack=[];
        for(let x=0;x<=bw;x++){let start=x,cur=x<bw?heights[x]:0;while(stack.length&&stack[stack.length-1].height>cur){const top=stack.pop(),area=top.height*(x-top.start);if(area>best.area)best={area,x:top.start,y:y-top.height+1,w:x-top.start,h:top.height};start=top.start}if(cur&&(!stack.length||stack[stack.length-1].height<cur))stack.push({start,height:cur})}
      }
      const inset=Math.max(3,Math.min(best.w,best.h)*.09);
      const balloon={id:c.id,x:c.x,y:c.y,w:bw,h:bh,mask:interior,glyphCount:count,layout:{x:(c.x+best.x+inset)/w,y:(c.y+best.y+inset)/h,w:Math.max(1,best.w-inset*2)/w,h:Math.max(1,best.h-inset*2)/h}};
      processed.set(c.id,balloon);return balloon;
    }
    // Non-balloon lettering: mask dark strokes in the original OCR area, then
    // reconstruct masked pixels from surrounding pixels using a growing frontier.
    function inpaintLocal(r) {
      const b=pixelBox(r,w,h,Math.max(3,Math.round(w*.004))),n=b.w*b.h,mask=new Uint8Array(n),light=[];
      for(let y=0;y<b.h;y++)for(let x=0;x<b.w;x++)if(x<3||y<3||x>b.w-4||y>b.h-4){const g=((b.y+y)*w+b.x+x)*4;light.push((data[g]+data[g+1]+data[g+2])/3)}
      light.sort((a,b)=>a-b);const background=light[Math.floor(light.length*.8)]||245;
      for(let y=1;y<b.h-1;y++)for(let x=1;x<b.w-1;x++){const g=((b.y+y)*w+b.x+x)*4;if((data[g]+data[g+1]+data[g+2])/3<background-35)mask[y*b.w+x]=1}
      const dilated=mask.slice();for(let y=1;y<b.h-1;y++)for(let x=1;x<b.w-1;x++)if(mask[y*b.w+x])for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)dilated[(y+dy)*b.w+x+dx]=1;
      const pending=dilated.slice(),q=new Int32Array(n),queued=new Uint8Array(n);let head=0,tail=0;
      const available=p=>{const x=p%b.w,y=Math.floor(p/b.w);return (x&&!pending[p-1])||(x<b.w-1&&!pending[p+1])||(y&&!pending[p-b.w])||(y<b.h-1&&!pending[p+b.w])};
      for(let p=0;p<n;p++)if(pending[p]&&available(p)){q[tail++]=p;queued[p]=1}
      while(head<tail){const p=q[head++],x=p%b.w,y=Math.floor(p/b.w),sum=[0,0,0];let count=0;
        for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=b.w||ny>=b.h||pending[ny*b.w+nx])continue;const g=((ny+b.y)*w+nx+b.x)*4;sum[0]+=result[g];sum[1]+=result[g+1];sum[2]+=result[g+2];count++}
        if(!count)continue;const g=((y+b.y)*w+x+b.x)*4;for(let k=0;k<3;k++)result[g+k]=Math.round(sum[k]/count);pending[p]=0;removed++;
        for(const np of [x?p-1:-1,x<b.w-1?p+1:-1,y?p-b.w:-1,y<b.h-1?p+b.w:-1])if(np>=0&&pending[np]&&!queued[np]){queued[np]=1;q[tail++]=np}
      }
    }
    sources.forEach(r=>{const c=findBalloon(r);if(c){bubbleBySource[r.id]=processBalloon(c)}else{warnings.push(r.id);if(options.mode!=='bubble')inpaintLocal(r)}});
    const canvas=makeCanvas(w,h);canvas.getContext('2d').putImageData(new ImageData(result,w,h),0,0);
    return {canvas,bubbleBySource,warnings,removedPixels:removed,original:input};
  }

  function splitColumns(text, rows) {
    const cols=[];for(const segment of text.split('\n')){const chars=Array.from(segment.replace(/[ \t]/g,''));if(!chars.length){cols.push([]);continue}const count=Math.ceil(chars.length/rows),balanced=Math.ceil(chars.length/count);let start=0;while(start<chars.length){let end=Math.min(chars.length,start+balanced);if(end<chars.length&&/[，。！？、；：,.!?]/u.test(chars[end])&&end-start>1)end--;cols.push(chars.slice(start,end));start=end}}return cols;
  }
  function horizontalLines(ctx,text,width){const lines=[];for(const paragraph of text.split('\n')){let line='';const tokens=paragraph.match(/[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*|\s+|./gu)||[];for(const token of tokens){if(line&&ctx.measureText(line+token).width>width){lines.push(line.trimEnd());line=token.trimStart()}else line+=token}lines.push(line.trimEnd())}return lines}
  function drawRegion(target,region,settings,balloon,dimensions) {
    const b=pixelBox(region,dimensions.w,dimensions.h),text=String(region.translation||'').trim();if(!text)return;
    const layer=makeCanvas(b.w,b.h),ctx=layer.getContext('2d'),family=settings.family||'ManhuaSans',weight=settings.font==='wenkai'?400:settings.font==='serif'?500:600;
    const vertical=settings.mode==='vertical'||(settings.mode==='auto'&&region.vertical);
    const desired=settings.size*dimensions.w/690,innerW=Math.max(1,b.w-8),innerH=Math.max(1,b.h-8);let fs=Math.min(desired,innerW,innerH),layout;
    for(;fs>5;fs-=.5){ctx.font=`${weight} ${fs}px ${family}`;if(vertical){const rows=Math.max(1,Math.floor(innerH/(fs*1.15))),cols=splitColumns(text,rows);if(cols.length*fs*1.28<=innerW){layout={cols,step:fs*1.15,colStep:fs*1.28};break}}else{const lines=horizontalLines(ctx,text,innerW);if(lines.length*fs*1.24<=innerH&&lines.every(l=>ctx.measureText(l).width<=innerW)){layout={lines,lineH:fs*1.24};break}}}
    if(!layout){ctx.font=`${weight} ${fs}px ${family}`;layout=vertical?{cols:splitColumns(text,Math.max(1,Math.floor(innerH/(fs*1.15)))),step:fs*1.15,colStep:fs*1.28}:{lines:horizontalLines(ctx,text,innerW),lineH:fs*1.24}}
    ctx.fillStyle=settings.color||'#171715';ctx.textAlign='center';ctx.textBaseline='middle';
    if(vertical){const {cols,step,colStep}=layout,right=(b.w+(cols.length-1)*colStep)/2;cols.forEach((col,i)=>{const top=(b.h-(col.length-1)*step)/2;col.forEach((ch,j)=>{const x=right-i*colStep,y=top+j*step;if(/[……—―]/u.test(ch)){ctx.save();ctx.translate(x,y);ctx.rotate(Math.PI/2);ctx.fillText(ch,0,0);ctx.restore()}else ctx.fillText(ch,x,y)})})}else{const {lines,lineH}=layout,top=(b.h-(lines.length-1)*lineH)/2;lines.forEach((line,i)=>ctx.fillText(line,b.w/2,top+i*lineH))}
    // Alpha clipping to the balloon interior prevents lettering crossing its contour.
    if(balloon){const pixels=ctx.getImageData(0,0,b.w,b.h);for(let y=0;y<b.h;y++)for(let x=0;x<b.w;x++){const bx=b.x+x-balloon.x,by=b.y+y-balloon.y;if(bx<0||by<0||bx>=balloon.w||by>=balloon.h||!balloon.mask[by*balloon.w+bx])pixels.data[(y*b.w+x)*4+3]=0}ctx.putImageData(pixels,0,0)}
    target.drawImage(layer,b.x,b.y);
  }
  function render(canvas,original,clean,regions,settings,mode='translated') {
    const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(mode==='original'||!clean?original:clean.canvas,0,0);
    if(mode==='translated')regions.forEach(r=>drawRegion(ctx,r,settings,clean?.bubbleBySource[r.sourceId],{w:canvas.width,h:canvas.height}));
  }
  window.ComicEngine={cleanText,render};
})();
