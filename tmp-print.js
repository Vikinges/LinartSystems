const fs = require('fs');
const data = fs.readFileSync('CHANGELOG.md');
const line = data.toString('utf8').split(/\r?\n/)[0];
console.log(JSON.stringify(line));
