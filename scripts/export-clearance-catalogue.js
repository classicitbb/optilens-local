"use strict";
// Exports a review-only standalone HTML. It installs no task and publishes nothing.
const fs = require("node:fs/promises");
const path = require("node:path");
const { buildCatalogue } = require("../lib/inventory/clearance-service");
async function exportCatalogue(catalogue, output) {
  if (!Array.isArray(catalogue.items) || !Number.isFinite(new Date(catalogue.expiresAt).getTime())) throw new Error("Invalid catalogue");
  const safe = {
    currency:"BBD",  asOf:catalogue.asOf, expiresAt:catalogue.expiresAt,
    items:catalogue.items.map(({sku,skuRight,skuLeft,description,name,material,manufacturer,family,design,option,diameter,base,addPower,verticalAxis,horizontalAxis,unit,quantity,priceBbd}) =>
      ({sku,skuRight,skuLeft,description,name,material,manufacturer,family,design,option,diameter,base,addPower,verticalAxis,horizontalAxis,unit,quantity,priceBbd}))
  };
  let html = await fs.readFile(path.join(__dirname,"../public/clearance-catalogue.html"),"utf8");
  const css = await fs.readFile(path.join(__dirname,"../public/styles/pages/clearance-catalogue.css"),"utf8");
  const js = await fs.readFile(path.join(__dirname,"../public/clearance-catalogue.js"),"utf8");
  html = html.replace('<link rel="stylesheet" href="/styles/pages/clearance-catalogue.css">', "<style>"+css+"</style>");
  const grids = await fs.readFile(path.join(__dirname,"../public/clearance-grids.js"),"utf8");
  html = html.replace('<script src="/clearance-grids.js"></script>', "<script>"+grids+"</script>");
  const data = JSON.stringify(safe).replace(/</g,"\\u003c").replace(/\u2028/g,"\\u2028").replace(/\u2029/g,"\\u2029");
  html = html.replace('<script src="/clearance-catalogue.js"></script>', '<script id="catalogue-data" type="application/json">'+data+'</script><script>'+js+'</script>');
  await fs.mkdir(path.dirname(output),{recursive:true});
  await fs.writeFile(output,html);
  return output;
}
if(require.main===module) {
  const inputIndex=process.argv.indexOf("--snapshot");
  const outputIndex=process.argv.indexOf("--output");
  const output=outputIndex>=0?process.argv[outputIndex+1]:path.join("output","clearance-catalogue","index.html");
  (async()=>{
    const data=inputIndex>=0?JSON.parse(await fs.readFile(process.argv[inputIndex+1],"utf8")):await buildCatalogue();
    await exportCatalogue(data,output);
    console.log("Review snapshot written: "+output);
  })().then(()=>process.exit(0)).catch(error=>{console.error(error.message);process.exit(1);});
}
module.exports={exportCatalogue};
