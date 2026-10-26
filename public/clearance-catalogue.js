"use strict";
(() => {
  const byId=id=>document.getElementById(id);
  const {gridsFor,power}=window.ClearanceGrids;
  let catalogue=null;
  const money=value=>Number(value).toLocaleString("en-BB",{minimumFractionDigits:2,maximumFractionDigits:2});
  function node(tag,text,className){const el=document.createElement(tag);if(text!=null)el.textContent=text;if(className)el.className=className;return el;}
  function render() {
    const target=byId("lenses");target.replaceChildren();
    if(!catalogue)return;
    if(Date.now()>=new Date(catalogue.expiresAt).getTime()){byId("message").textContent="Availability has expired. Refresh this page for current stock.";byId("totals").textContent="";return;}
    const needle=byId("search").value.trim().toLowerCase(),familyFilter=byId("family").value;
    const selected=catalogue.items.filter(item=>(!familyFilter||item.family===familyFilter)&&[item.name,item.sku,item.skuRight,item.skuLeft,item.description].join(" ").toLowerCase().includes(needle));
    const families=gridsFor(selected);
    const sort=byId("sort").value;
    families.sort((a,b)=>sort==="price"?Math.min(...a.items.map(i=>i.priceBbd))-Math.min(...b.items.map(i=>i.priceBbd)):sort==="quantity"?b.quantity-a.quantity:a.items[0].name.localeCompare(b.items[0].name));
    for(const [index,family] of families.entries()) {
      const section=node("section",null,"lens-family");
      const heading=node("div",null,"family-heading");
      const text=node("div");
      text.append(node("p",family.material+" · "+family.manufacturer,"eyebrow"),node("h3",family.design+" · "+family.option));
      const prices=family.items.map(item=>item.priceBbd),lo=Math.min(...prices),hi=Math.max(...prices);
      const label=family.unit==="pairs"?"pairs":"individual lenses";
      const price="BBD "+money(lo)+(lo===hi?"":"–"+money(hi))+" / "+(family.unit==="pairs"?"pair":"lens");
      heading.append(text,node("p",family.quantity.toLocaleString()+" "+label+" · "+price,"family-price"));section.append(heading);
      for(const [gridIndex,grid] of family.grids.entries()){
        const captionId="grid-"+index+"-"+gridIndex;
        const caption=node("h4",grid.diameter+" mm · "+family.family+" · quantities in "+label);caption.id=captionId;
        section.append(caption);
        const wrap=node("div",null,"power-wrap");wrap.tabIndex=0;wrap.setAttribute("role","region");wrap.setAttribute("aria-labelledby",captionId);
        const table=node("table",null,"power-grid"),thead=node("thead"),tr=node("tr");
        table.style.width="calc(var(--clearance-cell-width, 80px) * "+(grid.columns.length+1)+")";
        const cols=node("colgroup"),axis=node("col"),powers=node("col");axis.style.width="var(--clearance-cell-width, 80px)";powers.style.width="var(--clearance-cell-width, 80px)";powers.span=grid.columns.length;cols.append(axis,powers);table.append(cols);
        const corner=node("th",grid.verticalAxis+" \\ "+grid.horizontalAxis);corner.scope="col";tr.append(corner);
        for(const column of grid.columns){const th=node("th",power(column));th.scope="col";tr.append(th);}
        thead.append(tr);table.append(thead);
        const tbody=node("tbody");
        for(const row of grid.rows){
          const line=node("tr"),th=node("th",power(row));th.scope="row";line.append(th);
          for(const column of grid.columns){
            const td=node("td"),variants=grid.cells.get(row+":"+column)||[];
            if(!variants.length){td.append(node("span","—","no-stock"));td.setAttribute("aria-label","No stock");}
            for(const item of variants){
              const box=node("div",null,"power-stock");
              box.append(node("strong",item.quantity.toLocaleString()),node("small","BBD "+money(item.priceBbd)));
              box.title=item.quantity+" "+label+" · BBD "+money(item.priceBbd)+" per "+(family.unit==="pairs"?"pair":"lens")+" · SKU "+item.sku;
              td.append(box);
            }
            line.append(td);
          }
          tbody.append(line);
        }
        table.append(tbody);wrap.append(table);section.append(wrap);
      }
      target.append(section);
    }
    const eaches=selected.filter(i=>i.unit==="each").reduce((s,i)=>s+i.quantity,0),pairs=selected.filter(i=>i.unit==="pairs").reduce((s,i)=>s+i.quantity,0);
    byId("totals").textContent=families.length+" lens families · "+pairs.toLocaleString()+" pairs · "+eaches.toLocaleString()+" individual lenses";
    byId("message").textContent=families.length?"":"No lenses match this selection.";
  }
  async function load(){
    try{
      const embedded=byId("catalogue-data");
      if(embedded)catalogue=JSON.parse(embedded.textContent);
      else{const response=await fetch("/api/inventory-intelligence/clearance-catalogue",{cache:"no-store",credentials:"same-origin"});if(!response.ok)throw Error("Unavailable");catalogue=await response.json();}
      if(!Array.isArray(catalogue.items)||!Number.isFinite(new Date(catalogue.expiresAt).getTime()))throw Error("Invalid catalogue");
      byId("family").replaceChildren(node("option","All lens families"));byId("family").firstChild.value="";
      for(const family of [...new Set(catalogue.items.map(i=>i.family))].sort()){const option=node("option",family);option.value=family;byId("family").append(option);}
      byId("updated").textContent="Stock checked "+new Date(catalogue.asOf).toLocaleString("en-BB",{timeZone:"America/Barbados"})+" (Barbados time) · "+(embedded?"Review snapshot":"Refreshed daily on access");
      render();
    }catch(_){catalogue=null;byId("lenses").replaceChildren();byId("totals").textContent="";byId("message").textContent="Current availability could not be verified. Please try again later.";}
  }
  ["search","family","sort"].forEach(id=>byId(id).addEventListener("input",render));
  setInterval(()=>{if(catalogue&&Date.now()>=new Date(catalogue.expiresAt).getTime()){render();if(!byId("catalogue-data"))load();}},60000);
  load();
})();
