// Quick script to generate simple PNG icons without external deps
const { createCanvas } = require('canvas');
const fs = require('fs');

function makeIcon(size) {
  const c = createCanvas(size, size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#4f8ef7';
  ctx.font = `bold ${size * 0.5}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('C', size / 2, size / 2);
  fs.writeFileSync(`public/icon-${size}.png`, c.toBuffer('image/png'));
  console.log(`icon-${size}.png created`);
}

makeIcon(192);
makeIcon(512);
