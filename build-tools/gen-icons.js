// Generate PWA PNG icons: line-art house + heart ("home sweet home" feel).
// Pure Node, 4x supersampling for smooth edges, PNG via zlib.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const OUT_DIR = process.argv[2];
if (!OUT_DIR) { console.error('need output dir arg'); process.exit(1); }

const INK = [74, 69, 80];       // #4A4550 soft charcoal
const HEART = [255, 143, 179];  // #FF8FB3 pink

// Pastel rainbow vertical gradient background (Sanrio-ish)
const RAINBOW = [
  [0.00, [255, 214, 232]], // pink
  [0.20, [255, 226, 212]], // peach
  [0.40, [255, 247, 204]], // yellow
  [0.60, [212, 245, 212]], // mint
  [0.80, [212, 236, 255]], // sky
  [1.00, [232, 216, 255]], // lavender
];
function bgAt(uy){
  const t = Math.max(0, Math.min(1, uy / 100));
  for (let i = 1; i < RAINBOW.length; i++){
    if (t <= RAINBOW[i][0]){
      const t0 = RAINBOW[i-1][0], c0 = RAINBOW[i-1][1];
      const t1 = RAINBOW[i][0],   c1 = RAINBOW[i][1];
      const f = (t - t0) / (t1 - t0);
      return [0,1,2].map(k => Math.round(c0[k] + (c1[k] - c0[k]) * f));
    }
  }
  return RAINBOW[RAINBOW.length - 1][1];
}

// Stroke segments in user space (viewBox 0..100)
const SEGS = [
  // roof
  [24,50, 50,28], [50,28, 76,50],
  // house body  M32,50 V76 H68 V50
  [32,50, 32,76], [32,76, 68,76], [68,76, 68,50],
  // ground
  [26,76, 74,76],
  // door  M45,76 V63 H55 V76
  [45,76, 45,63], [45,63, 55,63], [55,63, 55,76],
];
const HALF = 1.7; // stroke-width 3.4 / 2
const KNOB = { cx:52.5, cy:70, r:1.1 };
const HRT = { hx:50, hy:45.2, s:5.6 };

function distToSeg(px,py, x1,y1,x2,y2){
  const dx=x2-x1, dy=y2-y1;
  const L2=dx*dx+dy*dy;
  let t = L2 ? ((px-x1)*dx+(py-y1)*dy)/L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx=x1+t*dx, cy=y1+t*dy;
  return Math.hypot(px-cx, py-cy);
}
function inHeart(px,py){
  const X=(px-HRT.hx)/HRT.s, Y=(HRT.hy-py)/HRT.s; // y up
  const a=X*X+Y*Y-1;
  return a*a*a - X*X*Y*Y*Y <= 0;
}
function colorAt(ux,uy){
  // strokes on top
  for (const s of SEGS) if (distToSeg(ux,uy,s[0],s[1],s[2],s[3]) <= HALF) return INK;
  const dk=Math.hypot(ux-KNOB.cx, uy-KNOB.cy);
  if (dk <= KNOB.r) return INK;
  if (inHeart(ux,uy)) return HEART;
  return bgAt(uy);
}

const CRC_TABLE=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);t[n]=c>>>0;}return t;})();
function crc32(buf){let c=0xFFFFFFFF;for(let i=0;i<buf.length;i++)c=CRC_TABLE[(c^buf[i])&0xFF]^(c>>>8);return (c^0xFFFFFFFF)>>>0;}
function chunk(type,data){const len=Buffer.alloc(4);len.writeUInt32BE(data.length,0);const body=Buffer.concat([Buffer.from(type,'ascii'),data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(body),0);return Buffer.concat([len,body,crc]);}

function renderPNG(size){
  const SS=4, big=size*SS, scale=big/100;
  const px=Buffer.alloc(big*big*4);
  for(let y=0;y<big;y++){
    for(let x=0;x<big;x++){
      const ux=x/scale, uy=y/scale;
      const c=colorAt(ux,uy);
      const i=(y*big+x)*4;
      px[i]=c[0];px[i+1]=c[1];px[i+2]=c[2];px[i+3]=255;
    }
  }
  const out=Buffer.alloc(size*size*4);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    let r=0,g=0,b=0;
    for(let sy=0;sy<SS;sy++)for(let sx=0;sx<SS;sx++){const i=((y*SS+sy)*big+(x*SS+sx))*4;r+=px[i];g+=px[i+1];b+=px[i+2];}
    const n=SS*SS,o=(y*size+x)*4;
    out[o]=Math.round(r/n);out[o+1]=Math.round(g/n);out[o+2]=Math.round(b/n);out[o+3]=255;
  }
  const stride=size*4, raw=Buffer.alloc((stride+1)*size);
  for(let y=0;y<size;y++){raw[y*(stride+1)]=0;out.copy(raw,y*(stride+1)+1,y*stride,y*stride+stride);}
  const idat=zlib.deflateSync(raw,{level:9});
  const sig=Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(size,0);ihdr.writeUInt32BE(size,4);ihdr[8]=8;ihdr[9]=6;
  return Buffer.concat([sig,chunk('IHDR',ihdr),chunk('IDAT',idat),chunk('IEND',Buffer.alloc(0))]);
}

for(const t of [{name:'icon-192.png',size:192},{name:'icon-512.png',size:512},{name:'apple-touch-icon.png',size:180}]){
  const buf=renderPNG(t.size);
  fs.writeFileSync(path.join(OUT_DIR,t.name),buf);
  console.log(`wrote ${t.name} (${t.size}px, ${buf.length} bytes)`);
}
