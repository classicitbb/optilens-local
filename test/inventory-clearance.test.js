const test = require("node:test");
const assert = require("node:assert/strict");
const { clearancePrice, reviewCandidates, saleProjection, createCatalogueCache } = require("../lib/inventory/clearance-service");
const { buildPolicy } = require("../lib/inventory/policy");
const item = { itemId: "1:1:1:1:1:1", sku: "001", itemLabel: "Blank", onHand: 14, stock:{right:2,left:4,pairs:4}, openPoQuantity: 0, usage30: 0, usage90: 0, unitCost: 20, supplierId:"1", supplierMappingQuality:"CONFIRMED", stockFreshnessDays:null };
function review(items = [item], candidates = [item.itemId]) {
  return reviewCandidates({ candidates, evidence: { items, truncated:false }, policy: buildPolicy() });
}
test("supplier USD pair cost is halved before conversion to BBD per lens", () => {
  assert.equal(clearancePrice(20), 26.60);
  assert.equal(clearancePrice(13.55), 18.02);
  for (const invalid of [0,-1,NaN,Infinity,null,"20"]) assert.equal(clearancePrice(invalid), null);
});
test("current stock and current usage control eligibility; duplicated candidates count once", () => {
  assert.equal(review([item], [item.itemId,item.itemId]).eligible.length, 1);
  assert.equal(review([{...item,onHand:0}]).exclusions.noCurrentStock, 1);
  assert.equal(review([{...item,usage30:120,usage90:300}]).exclusions.noLongerWriteOff, 1);
  assert.equal(review([{...item,unitCost:0}]).exclusions.invalidCost, 1);
  assert.throws(() => reviewCandidates({candidates:[],evidence:{items:[],truncated:true},policy:buildPolicy()}), /incomplete/);
});
test("sale projection omits costs, internal ids and review rationale", () => {
  const data = saleProjection(review(), {[item.itemId]: {name:"CR39 Regular",familyName:"Single Vision",materialName:"CR39",manufacturerName:"Supplier",lensTypeName:"Regular",optionName:"Clear",diameter:70,base:1,addPower:-0.5}}, "2026-10-26T12:00:00Z");
  assert.equal(data.totals.eaches,14);
  assert.equal(data.items[0].priceBbd,26.6);
  for (const key of ["unitCost","itemId","supplierId","evidence"]) assert.equal(key in data.items[0], false);
  assert.equal(saleProjection(review(), {}, "2026-10-26T12:00:00Z").review.exclusions.missingIdentity,1);
});
test("daily cache shares refreshes and refuses expired data on source failure", async () => {
  let now = 1000, calls = 0, fail = false;
  const get = createCatalogueCache(async () => {calls++; if(fail) throw new Error("offline"); return {expiresAt:new Date(now+1000).toISOString()};}, () => now);
  await Promise.all([get(),get(),get()]);
  assert.equal(calls,1);
  await get(); assert.equal(calls,1);
  now=2001;fail=true;
  await assert.rejects(get(), /offline/); assert.equal(calls,2);
  fail=false;await get();assert.equal(calls,3);
});
test("catalogue route keeps existing authentication and no-store boundary", async () => {
  const {handleInventoryRoute} = require("../lib/inventory/routes");
  let response, cache;
  await handleInventoryRoute({
    req:{method:"GET"},res:{setHeader:(_k,v)=>cache=v},
    url:new URL("http://localhost/api/inventory-intelligence/clearance-catalogue"),
    currentUser:async()=>{const e=new Error("Sign in required");e.statusCode=401;throw e;},
    sendJson:(_res,body,status)=>response={body,status}
  });
  assert.equal(response.status,401);
  assert.equal(cache,"private, no-store");
});

test("preview page and its HTML alias remain administrator-only and edition-scoped", () => {
  const fs=require("node:fs");
  const server=fs.readFileSync(require.resolve("../server"),"utf8");
  assert.match(server, /"\/modules\/inventory-clearance": \["platform\.admin"\]/);
  assert.match(server, /"\/clearance-catalogue\.html": \["platform\.admin"\]/);
  const edition=fs.readFileSync(require.resolve("../lib/edition"),"utf8");
  assert.match(edition, /pages: \[.*"\/modules\/inventory-clearance".*"\/clearance-catalogue\.html"/);
});
test("standalone export escapes script content and strips internal fields", async () => {
  const fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
  const {exportCatalogue}=require("../scripts/export-clearance-catalogue");
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"clearance-export-"));
  try {
    const file=path.join(dir,"index.html");
    await exportCatalogue({asOf:"2026-10-26T12:00:00Z",expiresAt:"2026-10-27T12:00:00Z",review:{private:"PRIVATE_REVIEW"},
      items:[{name:"</script><script>bad()</script>",sku:"001",quantity:2,priceBbd:10,unitCost:"PRIVATE_COST",itemId:"PRIVATE_ID"}]},file);
    const html=await fs.readFile(file,"utf8");
    const raw=html.match(/<script id="catalogue-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
    const parsed=JSON.parse(raw);
    assert.equal(parsed.items[0].name,"</script><script>bad()</script>");
    assert.doesNotMatch(raw, /<script|PRIVATE_COST|PRIVATE_ID|PRIVATE_REVIEW/);
    assert.doesNotMatch(html, /src="\/clearance-catalogue.js"|href="\/styles\/pages\/clearance-catalogue.css"/);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
test("multifocals offer whole paired stock plus matched right/left, and price per pair", () => {
  const identity={name:"Poly Progressive",familyName:"Progressive",materialName:"Poly",manufacturerName:"Supplier",lensTypeName:"Design",optionName:"Gray",diameter:75,base:4,addPower:2};
  const data=saleProjection(review(),{[item.itemId]:identity},"2026-10-26T12:00:00Z");
  assert.equal(data.items[0].quantity,6);
  assert.equal(data.items[0].unit,"pairs");
  assert.equal(data.items[0].priceBbd,53.2);
  assert.equal("stock" in data.items[0],false);
  const orphan=review([{...item,onHand:3,stock:{right:3,left:0,pairs:0}}]);
  assert.equal(saleProjection(orphan,{[item.itemId]:identity},"2026-10-26T12:00:00Z").items.length,0);
  assert.equal(clearancePrice(20.01,"pairs"),53.23,"round pair price directly, not twice a rounded each price");
  const bifocal=saleProjection(review(),{[item.itemId]:{...identity,familyName:"Bifocal"}},"2026-10-26T12:00:00Z");
  assert.equal(bifocal.items[0].quantity,6);
});
test("grids group exact material/manufacturer/design/colour and keep diameters separate", () => {
  const {gridsFor}=require("../public/clearance-grids");
  const base={material:"CR39",manufacturer:"M",design:"Regular",option:"Clear",family:"Single Vision",unit:"each",quantity:2,priceBbd:5,base:1,addPower:-0.5,diameter:65,verticalAxis:"Sphere",horizontalAxis:"Cylinder"};
  const families=gridsFor([base,{...base,diameter:70},{...base,option:"Gray"},{...base,manufacturer:"Other"}]);
  assert.equal(families.length,3);
  assert.equal(families[0].grids.length,2);
  assert.deepEqual(families[0].grids[0].rows,[100]);
  assert.deepEqual(families[0].grids[0].columns,[-50]);
});
test("outbound publication is dry-run by default and never sends review or cost fields", async () => {
  const {publicationPayload,publishCatalogue}=require("../lib/inventory/clearance-publisher");
  const snapshot={asOf:"2026-10-26T12:00:00.000Z",expiresAt:"2026-10-27T12:00:00.000Z",totals:{pairs:2,eaches:3},items:[{name:"Lens",quantity:2,unitCost:99,itemId:"private"}],review:{secret:true}};
  const token="x".repeat(43);
  const payload=publicationPayload(snapshot,token);
  assert.equal(payload.tokenHash.length,64);
  assert.doesNotMatch(JSON.stringify(payload), /unitCost|private|secret/);
  let calls=0;
  await publishCatalogue({build:async()=>snapshot,fetchImpl:async()=>{calls++;}});
  assert.equal(calls,0);
  const result=await publishCatalogue({commit:true,build:async()=>snapshot,config:{OPTILENS_CLEARANCE_PUBLISH_URL:"https://example.invalid",OPTILENS_CLEARANCE_API_KEY:"test",OPTILENS_CLEARANCE_PUBLIC_KEY:"public-test",OPTILENS_CLEARANCE_LINK_TOKEN:token},
    fetchImpl:async()=>{calls++;return {ok:true,json:async()=>({ok:true,asOf:snapshot.asOf,items:1})};}});
  assert.equal(result.published,true);assert.equal(calls,1);
});
