const fs = require('fs');
const lines = fs.readFileSync('tmp-inline.js','utf8').split(/\r?\n/);
let buf = '';
for (let i=0;i<lines.length;i++){
  buf += lines[i] + '\n';
  try {
    new Function(buf);
  } catch (err) {
    const msg = String(err && err.message || err);
    if (!msg.includes('Unexpected end of input')) {
      console.log('First non-EOF error at line', i+1);
      console.log(msg);
      process.exit(0);
    }
  }
}
console.log('No non-EOF parse errors');
