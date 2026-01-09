const { createCanvas } = require('canvas');
const fs = require('fs');

const sizes = [16, 32, 48, 128];

function drawIcon(ctx, size) {
  const scale = size / 128;

  // Create gradient
  const gradient = ctx.createLinearGradient(0, 0, size, size);
  gradient.addColorStop(0, '#667eea');
  gradient.addColorStop(1, '#764ba2');

  // Background circle
  ctx.beginPath();
  ctx.arc(64 * scale, 64 * scale, 60 * scale, 0, Math.PI * 2);
  ctx.fillStyle = gradient;
  ctx.fill();

  // Document
  ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.fillRect(36 * scale, 24 * scale, 56 * scale, 72 * scale);

  // Text lines
  ctx.fillStyle = '#667eea';
  ctx.fillRect(44 * scale, 50 * scale, 40 * scale, 4 * scale);
  ctx.fillStyle = 'rgba(102, 126, 234, 0.7)';
  ctx.fillRect(44 * scale, 60 * scale, 36 * scale, 4 * scale);
  ctx.fillStyle = 'rgba(102, 126, 234, 0.5)';
  ctx.fillRect(44 * scale, 70 * scale, 40 * scale, 4 * scale);
}

sizes.forEach(size => {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  drawIcon(ctx, size);
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(`icon${size}.png`, buffer);
  console.log(`Created icon${size}.png`);
});
