"use strict";
const {createHash}=require("node:crypto");
const {buildCatalogue}=require("./clearance-service");
const {loadPublisherConfig}=require("./clearance-publish-config");

function publicationPayload(catalogue,token) {
  if(!/^[A-Za-z0-9_-]{43}$/.test(String(token||"")))throw new Error("Configure the private clearance link token through approved host-local configuration.");
  const items=catalogue.items.map(({sku,skuRight,skuLeft,description,name,material,manufacturer,family,design,option,diameter,base,addPower,verticalAxis,horizontalAxis,unit,quantity,priceBbd})=>
    ({sku,skuRight,skuLeft,description,name,material,manufacturer,family,design,option,diameter,base,addPower,verticalAxis,horizontalAxis,unit,quantity,priceBbd}));
  return {action:"publish",tokenHash:createHash("sha256").update(token).digest("hex"),snapshot:{currency:"BBD",asOf:catalogue.asOf,expiresAt:catalogue.expiresAt,items}};
}
async function publishCatalogue({commit=false,config=null,build=buildCatalogue,fetchImpl=fetch}={}) {
  const catalogue=await build();
  const summary={dryRun:!commit,asOf:catalogue.asOf,expiresAt:catalogue.expiresAt,...catalogue.totals};
  if(!commit)return summary;
  config=config||loadPublisherConfig();
  const url=config.OPTILENS_CLEARANCE_PUBLISH_URL;
  if(!url||!/^https:\/\//i.test(url))throw new Error("A secure clearance receiver URL is required.");
  if(!config.OPTILENS_CLEARANCE_API_KEY)throw new Error("A scoped clearance publishing API key is required.");
  if(!config.OPTILENS_CLEARANCE_PUBLIC_KEY)throw new Error("The website publishable API key is required.");
  const payload=publicationPayload(catalogue,config.OPTILENS_CLEARANCE_LINK_TOKEN);
  const response=await fetchImpl(url,{method:"POST",headers:{"content-type":"application/json","apikey":config.OPTILENS_CLEARANCE_PUBLIC_KEY},
    body:JSON.stringify({p_api_key:config.OPTILENS_CLEARANCE_API_KEY,p_token_hash:payload.tokenHash,p_snapshot:payload.snapshot}),signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error("Clearance publication was not accepted (HTTP "+response.status+").");
  const result=await response.json();
  if(result.ok!==true||result.asOf!==catalogue.asOf||result.items!==catalogue.items.length)throw new Error("The receiver did not confirm this clearance snapshot.");
  return {...summary,published:true};
}
module.exports={publicationPayload,publishCatalogue};
