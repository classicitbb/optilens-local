"use strict";
// Dry-run by default. --commit performs an externally visible publication.
const fs=require("node:fs"),path=require("node:path");
const {publishCatalogue}=require("../lib/inventory/clearance-publisher");
function record(result){
  const dir=path.join(__dirname,"../data/clearance");
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,"last-publish.json"),JSON.stringify(result,null,2));
  fs.appendFileSync(path.join(dir,"publish-history.ndjson"),JSON.stringify(result)+"\n");
}
const commit=process.argv.includes("--commit");
publishCatalogue({commit})
  .then(result=>{if(commit)record({...result,completedAt:new Date().toISOString()});console.log(JSON.stringify(result,null,2));process.exit(0);})
  .catch(()=>{if(commit)record({published:false,failedAt:new Date().toISOString()});console.error("Clearance publishing failed. Verify configuration and receiver status; no successful publication is confirmed.");process.exit(1);});
