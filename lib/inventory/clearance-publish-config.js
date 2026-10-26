"use strict";
const fs=require("node:fs");
const path=require("node:path");
const {execFileSync}=require("node:child_process");
const CONFIG_FILE=path.join(__dirname,"../../data/clearance/publish-config.dpapi");
const NAMES=["OPTILENS_CLEARANCE_PUBLISH_URL","OPTILENS_CLEARANCE_API_KEY","OPTILENS_CLEARANCE_LINK_TOKEN","OPTILENS_CLEARANCE_PUBLIC_KEY"];
function loadPublisherConfig(env=process.env){
  let stored={};
  if(NAMES.some(name=>!env[name])&&fs.existsSync(CONFIG_FILE)){
    if(process.platform!=="win32")throw new Error("The protected publisher configuration requires its Windows host.");
    const command='Add-Type -AssemblyName System.Security; $file=Join-Path $env:OPTILENS_CLEARANCE_CONFIG_ROOT "data/clearance/publish-config.dpapi"; $bytes=[IO.File]::ReadAllBytes($file); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine))';
    try{
      stored=JSON.parse(execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",command],{encoding:"utf8",windowsHide:true,env:{...process.env,OPTILENS_CLEARANCE_CONFIG_ROOT:path.join(__dirname,"../..")}}));
    }catch{throw new Error("The protected publisher configuration could not be read.");}
  }
  return Object.fromEntries(NAMES.map(name=>[name,env[name]||stored[name]||""]));
}
module.exports={loadPublisherConfig};
