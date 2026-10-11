const fs=require('node:fs'),path=require('node:path');
const root=fs.existsSync(path.join(__dirname,'rewrite'))?path.join(__dirname,'rewrite'):path.join(__dirname,'..');
const {createTranslator}=require(path.join(root,'hans-translator'));
const source="Acknowledged the user's directive to proceed. Need to ensure adherence to established boundaries: no unauthorized software downloads, configuration changes, or alteration of the technical approach. Any alternative solutions require a risk/benefit analysis and user approval. Also, any high-risk/deletion operations need independent confirmation. Complex tasks necessitate a clear implementation plan before code modification. If encountering roadblocks or ambiguities, will pause and seek clarification. I'm thinking through how to approach this.";
module.exports=source;
if(require.main===module)createTranslator('missing-config.json').translate([source]).then(x=>{if(typeof x[0]!=='string'||!/[\u3400-\u9fff]/.test(x[0]))throw Error('Screenshot paragraph was not translated');console.log(JSON.stringify(x))}).catch(e=>{console.error(e);process.exitCode=1});
