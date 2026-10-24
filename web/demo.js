// The built-in demo clip: a subject moving over a blue key background, so keys and trails
// work before you import anything. Works on a canvas or an OffscreenCanvas.
export function drawDemo(c, t) {
  const g = c.getContext('2d');
  g.fillStyle = '#1d3fd8'; g.fillRect(0, 0, 640, 480);
  const x = 320 + Math.sin(t * 0.9) * 200, y = 260 + Math.sin(t * 1.7) * 70;
  g.save(); g.translate(x, y); g.rotate(Math.sin(t * 1.3) * 0.3);
  g.fillStyle = '#ff7a2f'; g.beginPath(); g.ellipse(0, 40, 52, 78, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ffd9b0'; g.beginPath(); g.arc(0, -64, 42, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#1a1a1a'; g.beginPath(); g.arc(-14, -70, 6, 0, 7); g.arc(14, -70, 6, 0, 7); g.fill();
  g.strokeStyle = '#1a1a1a'; g.lineWidth = 5; g.beginPath(); g.arc(0, -58, 18, 0.2, Math.PI - 0.2); g.stroke();
  g.strokeStyle = '#ff7a2f'; g.lineWidth = 18; g.lineCap = 'round';
  g.beginPath(); g.moveTo(-40, 10); g.lineTo(-95, -30 + Math.sin(t * 6) * 40); g.moveTo(40, 10); g.lineTo(95, -30 - Math.sin(t * 6) * 40); g.stroke();
  g.restore();
  for (let i = 0; i < 6; i++) { g.fillStyle = `hsl(${(i * 60 + t * 40) % 360} 90% 55%)`; g.beginPath(); g.arc(560, 80, 50 - i * 8, 0, 7); g.fill(); }
  g.fillStyle = '#fff'; g.font = 'bold 44px Geist, Arial, sans-serif'; g.fillText('TELL YOUR FRIENDS', ((-t * 120) % 1100 + 1100) % 1100 - 420, 450);
}
