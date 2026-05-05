const fs = require('fs');
const code = fs.readFileSync('tmp-inline.js','utf8');
let line=1, col=0;
let stack=[]; // {ch,line,col}
let i=0;
let state='code';
const push=(ch)=>stack.push({ch,line,col});
const pop=(ch)=>{
  for(let j=stack.length-1;j>=0;j--){
    if((ch==='}'&&stack[j].ch==='{')||(ch===')'&&stack[j].ch==='(')||(ch===']'&&stack[j].ch==='[')){
      stack.splice(j,1);
      return;
    }
  }
};
for(i=0;i<code.length;i++){
  const c=code[i];
  col++;
  if(c==='\n'){line++;col=0;}
  if(state==='code'){
    if(c==='/' && code[i+1]==='/'){state='linecomment'; i++; col++; continue;}
    if(c==='/' && code[i+1]==='*'){state='blockcomment'; i++; col++; continue;}
    if(c==="'"){state='single'; continue;}
    if(c==='"'){state='double'; continue;}
    if(c==='`'){state='template'; continue;}
    if(c==='{'||c==='('||c==='['){push(c);}
    else if(c==='}'||c===')'||c===']'){pop(c);}
  } else if(state==='linecomment'){
    if(c==='\n'){state='code';}
  } else if(state==='blockcomment'){
    if(c==='*' && code[i+1]==='/'){state='code'; i++; col++; continue;}
  } else if(state==='single'){
    if(c==='\\'){i++; col++; continue;}
    if(c==="'"){state='code';}
  } else if(state==='double'){
    if(c==='\\'){i++; col++; continue;}
    if(c==='"'){state='code';}
  } else if(state==='template'){
    if(c==='\\'){i++; col++; continue;}
    if(c==='`'){state='code';}
    else if(c==='$' && code[i+1]==='{'){push('{'); i++; col++;}
  }
}
console.log('Unclosed stack size:', stack.length);
console.log(stack.slice(-10));
