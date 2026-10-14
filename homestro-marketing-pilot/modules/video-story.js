const clean=v=>String(v||'').replace(/<[^>]*>/g,' ').replace(/[{}\\]/g,'').replace(/\s+/g,' ').trim();
export function wrapStoryText(value,width=29,maxLines=2) {
  const lines=[];let line='';
  for(const word of clean(value).split(' ').filter(Boolean)) {
    if(line&&(line+' '+word).length>width){lines.push(line);line='';if(lines.length>=maxLines)break;}
    line+=(line?' ':'')+word;
  }
  if(line&&lines.length<maxLines)lines.push(line);
  return lines.join('\\N');
}
const stamp=t=>{const n=Math.max(0,Math.round(t*100)),h=Math.floor(n/360000),m=Math.floor(n%360000/6000),s=Math.floor(n%6000/100);return h+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')+'.'+String(n%100).padStart(2,'0');};
export function storyAss(copy,script,duration) {
  const head=['[Script Info]','ScriptType: v4.00+','PlayResX: 720','PlayResY: 1280','WrapStyle: 2','ScaledBorderAndShadow: yes','',
    '[V4+ Styles]','Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Brand,DejaVu Sans,26,&H00395413,&H00395413,&H00F4F4EF,&H00F4F4EF,-1,0,0,0,100,100,2,0,1,0,0,7,55,55,65,1',
    'Style: Head,DejaVu Sans,44,&H00395413,&H00395413,&H00F4F4EF,&H00F4F4EF,-1,0,0,0,100,100,0,0,1,0,0,8,45,45,122,1',
    'Style: Caption,DejaVu Sans,35,&H00FFFFFF,&H00FFFFFF,&H00395413,&H00395413,-1,0,0,0,100,100,0,0,3,9,0,2,55,55,315,1',
    'Style: Footer,DejaVu Sans,28,&H00395413,&H00395413,&H00F4F4EF,&H00F4F4EF,-1,0,0,0,100,100,0,0,1,0,0,2,55,55,210,1','',
    '[Events]','Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'];
  const events=[],add=(start,end,style,text)=>events.push('Dialogue: 0,'+stamp(start)+','+stamp(end)+','+style+',,0,0,0,,'+text);
  add(0,duration,'Brand','HOMESTRO');add(0,duration,'Footer','homestro.de');
  const benefits=(copy.benefits||[]).map(x=>clean(x.text||x)).filter(Boolean);
  const evidence=clean([copy.title,copy.description,...benefits].join(' ')).toLowerCase();
  const hook=/loses fell|entwirren|fellpflege/.test(evidence)?'Loses Fell? Zeit für Pflege.':
    /aufbewahr|organisi|ordnung/.test(evidence)?'Mehr Ordnung im Alltag?':copy.hook||copy.title;
  const headlines=[hook,benefits[0]||copy.title,benefits[1]||copy.title,'Jetzt bei Homestro entdecken'];
  const boundaries=[0,duration*.22,duration*.47,duration*.74,duration];
  headlines.forEach((s,i)=>add(boundaries[i],boundaries[i+1],'Head',wrapStoryText(s,27,2)));
  const words=clean(script).split(' ').filter(Boolean),groups=[];
  for(let i=0;i<words.length;i+=5)groups.push(words.slice(i,i+5).join(' '));
  const total=groups.reduce((n,x)=>n+x.length,0)||1;let used=0;
  groups.forEach((text,i)=>{const start=duration*used/total;used+=text.length;add(start,i===groups.length-1?duration:duration*used/total,'Caption',wrapStoryText(text,30,2));});
  return head.concat(events).join('\n')+'\n';
}
